"""Run only a new synthetic cluster. Never consume DATABASE_URL or Vela credentials."""

import hashlib
import json
import os
import re
from pathlib import Path
import secrets
import selectors
import subprocess
import tempfile

bin_dir = Path(os.environ.get('A2_PGBIN', '/nonexistent')).resolve()
required = ['initdb', 'pg_ctl', 'psql', 'pg_dump', 'pg_restore', 'postgres']
if not all((bin_dir / name).is_file() for name in required):
    raise SystemExit('Set A2_PGBIN to the directory containing the disposable PostgreSQL binaries.')
if os.getuid() == 0:
    raise SystemExit('Run the disposable cluster as a non-root user.')

with tempfile.TemporaryDirectory(prefix='cf-a2-pg-') as tmp:
    root = Path(tmp)
    data = root / 'data'
    socket = root / 'socket'
    socket.mkdir(mode=0o700)
    admin_password = secrets.token_urlsafe(24)
    task_password = secrets.token_urlsafe(24)
    password_file = root / 'init-password'
    password_file.write_text(admin_password)
    password_file.chmod(0o600)
    env = {'PATH': os.environ['PATH'], 'LC_ALL': 'C', 'PGCONNECT_TIMEOUT': '3'}
    admin = 'cf_a2_supervisor'
    task = 'cf_a2_task'
    source = 'cf_a2_source'
    target = 'cf_a2_taskdb'
    shadow = 'cf_a2_shadowdb'
    require_vector = os.environ.get('A2_REQUIRE_PG18_VECTOR') == '1'
    vector_report = None
    started = False
    exporter = None

    def run(name, args, *, role=None, sql=None, check=True):
        child_env = dict(env)
        if role:
            child_env['PGPASSWORD'] = admin_password if role == admin else task_password
        result = subprocess.run([str(bin_dir / name), *map(str, args)], env=child_env,
                                input=sql, capture_output=True, text=True, timeout=30)
        if check and result.returncode:
            raise RuntimeError(f'{name} failed: {result.stderr}')
        return result

    def connection(db, role):
        return ['--host', socket, '--port', '55432', '--username', role, '--dbname', db, '--no-password']

    def query(db, sql, role=admin, check=True):
        return run('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', *connection(db, role)],
                   role=role, sql=sql, check=check)

    try:
        version = run('postgres', ['--version']).stdout.strip()
        if require_vector and not re.search(r'PostgreSQL\) 18\.', version):
            raise RuntimeError('The representative pgvector probe requires PostgreSQL 18.')
        run('initdb', ['-D', data, '-U', admin, '--pwfile', password_file,
                       '--auth-local=scram-sha-256', '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
        run('pg_ctl', ['-D', data, '-l', root / 'server.log', '-o',
                       f"-k {socket} -h '' -p 55432 -c max_connections=20 -c shared_buffers=16MB", '-w', 'start'])
        started = True
        query('postgres', f"CREATE ROLE {task} LOGIN PASSWORD '{task_password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;")
        query('postgres', f'CREATE DATABASE {source} TEMPLATE template0;')
        query(source, """
            CREATE TABLE seed (id bigserial PRIMARY KEY, label text UNIQUE NOT NULL, synthetic_token text NOT NULL);
            INSERT INTO seed(label, synthetic_token) VALUES ('one', 'fixture-not-a-real-token'), ('two', 'fixture-not-a-real-token');
            CREATE VIEW seed_count AS SELECT count(*) AS total FROM seed;
            CREATE TABLE blob_links (id oid PRIMARY KEY);
            INSERT INTO blob_links SELECT lo_from_bytea(0, decode('66697874757265', 'hex'));
        """)
        if require_vector:
            query(source, 'CREATE EXTENSION vector;')
            extension = query(source, "SELECT extversion FROM pg_extension WHERE extname='vector';").stdout.strip()
            if extension != '0.8.7':
                raise RuntimeError('The representative profile requires pgvector 0.8.7.')
            query(source, """
                CREATE TABLE embeddings (id integer PRIMARY KEY, embedding vector(3) NOT NULL);
                INSERT INTO embeddings VALUES (1, '[1,2,3]'), (2, '[4,5,6]');
                CREATE INDEX embeddings_hnsw ON embeddings USING hnsw (embedding vector_l2_ops);
            """)
        query('postgres', f'REVOKE CONNECT ON DATABASE {source} FROM {task};')
        inherited_connect = query(source, 'SELECT current_database();', role=task)
        source_table_read = query(source, 'SELECT count(*) FROM seed;', role=task, check=False)
        query('postgres', f'REVOKE CONNECT ON DATABASE {source} FROM PUBLIC;')
        denied_source = query(source, 'SELECT current_database();', role=task, check=False)

        export_env = dict(env, PGPASSWORD=admin_password)
        exporter = subprocess.Popen([str(bin_dir / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
                                     *map(str, connection(source, admin))], env=export_env,
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        exporter.stdin.write('BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT pg_export_snapshot();\n')
        exporter.stdin.flush()
        selector = selectors.DefaultSelector()
        selector.register(exporter.stdout, selectors.EVENT_READ)
        if not selector.select(timeout=10):
            raise RuntimeError('Snapshot export timed out.')
        snapshot = exporter.stdout.readline().strip()
        selector.close()
        if not snapshot or not all(c in '0123456789ABCDEF-' for c in snapshot.upper()):
            raise RuntimeError('Invalid synthetic snapshot identifier.')
        query(source, "INSERT INTO seed(label, synthetic_token) VALUES ('after-snapshot', 'fixture-not-a-real-token');")
        archive = root / 'snapshot.dump'
        run('pg_dump', ['--format=custom', '--snapshot', snapshot, '--file', archive, *connection(source, admin)], role=admin)
        exporter.communicate('COMMIT;\n', timeout=10)
        if exporter.returncode:
            raise RuntimeError('Snapshot exporter did not commit successfully.')
        exporter = None
        query('postgres', f'CREATE DATABASE {target} OWNER {task} TEMPLATE template0;')
        query('postgres', f'REVOKE ALL ON DATABASE {target} FROM PUBLIC;')
        # NOINHERIT means database ownership alone did not grant schema CREATE in this fixture.
        query(target, f'GRANT USAGE, CREATE ON SCHEMA public TO {task};')
        restore_args = []
        if require_vector:
            # Supervisor installs the non-trusted extension; task never receives that authority.
            denied_extension = query(target, 'CREATE EXTENSION vector;', role=task, check=False)
            if denied_extension.returncode == 0:
                raise RuntimeError('Non-superuser unexpectedly installed the vector extension.')
            query(target, 'CREATE EXTENSION vector;')
            toc = run('pg_restore', ['--list', archive]).stdout
            excluded = []
            selected = []
            for entry in toc.splitlines():
                if re.match(r'^\d+; \d+ \d+ (?:EXTENSION - vector|COMMENT - EXTENSION vector)(?:\s|$)', entry):
                    excluded.append(entry)
                    selected.append('; ' + entry)
                else:
                    selected.append(entry)
            if not any(' EXTENSION - vector' in entry for entry in excluded):
                raise RuntimeError('Expected vector extension entry missing from archive inventory.')
            restore_list = root / 'restore.list'
            restore_list.write_text('\n'.join(selected) + '\n')
            restore_args = ['--use-list', restore_list]
        run('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction',
                           *restore_args, *connection(target, task), archive], role=task)
        if require_vector:
            inventory_sql = "SELECT relkind, relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY relkind,relname;"
            source_inventory = query(source, inventory_sql).stdout
            clone_inventory = query(target, inventory_sql, role=task).stdout
            source_vectors = query(source, 'SELECT id,embedding::text FROM embeddings ORDER BY id;').stdout
            clone_vectors = query(target, 'SELECT id,embedding::text FROM embeddings ORDER BY id;', role=task).stdout
            clone_nearest = query(target, "SELECT id FROM embeddings ORDER BY embedding <-> '[1,2,3]' LIMIT 1;", role=task).stdout.strip()
            query('postgres', f'CREATE DATABASE {shadow} OWNER {task} TEMPLATE template0;')
            query('postgres', f'REVOKE ALL ON DATABASE {shadow} FROM PUBLIC;')
            query(shadow, f'GRANT USAGE, CREATE ON SCHEMA public TO {task}; CREATE EXTENSION vector;')
            query(shadow, 'CREATE TABLE migration_probe(id integer PRIMARY KEY); ALTER TABLE migration_probe ADD COLUMN embedding vector(3);', role=task)
            target_no_shadow_table = query(target, "SELECT count(*) FROM information_schema.tables WHERE table_name='migration_probe';", role=task).stdout.strip() == '0'
            denied_create_db = query(target, 'CREATE DATABASE cf_a2_forbidden;', role=task, check=False)
            if denied_create_db.returncode == 0:
                raise RuntimeError('Task unexpectedly has database provisioning authority.')
            query(shadow, 'DROP TABLE migration_probe;', role=task)
            query('postgres', f'DROP DATABASE {shadow};')
            vector_report = {
                'version': extension,
                'extensionInstalledOnlyBySupervisor': denied_extension.returncode != 0,
                'supervisorPreprovisionedExtensionArchiveEntries': len(excluded),
                'restoreUsesTaskLogin': True,
                'sourceAndCloneRelationInventoryEqual': source_inventory == clone_inventory,
                'vectorsPreserved': source_vectors == clone_vectors,
                'nearestNeighborId': int(clone_nearest),
                'hnswIndexRestored': 'embeddings_hnsw' in clone_inventory,
                'shadowDatabaseMigrationAndReset': True,
                'shadowMigrationDidNotAffectTarget': target_no_shadow_table,
                'taskCannotCreateDatabase': denied_create_db.returncode != 0,
                'shadowDatabaseDropped': True,
            }
            if not all(vector_report[key] is True for key in [
                'extensionInstalledOnlyBySupervisor', 'restoreUsesTaskLogin',
                'sourceAndCloneRelationInventoryEqual', 'vectorsPreserved', 'hnswIndexRestored',
                'shadowMigrationDidNotAffectTarget', 'taskCannotCreateDatabase',
            ]) or clone_nearest != '1':
                raise RuntimeError('PostgreSQL 18/pgvector checks did not pass.')
        source_baseline = query(source, 'SELECT md5(string_agg(row_to_json(seed)::text, E\'\\n\' ORDER BY id)) FROM seed;').stdout.strip()
        source_rows = query(source, 'SELECT count(*) FROM seed;').stdout.strip()
        clone_rows = query(target, 'SELECT count(*) FROM seed;', role=task).stdout.strip()
        clone_view = query(target, 'SELECT total FROM seed_count;', role=task).stdout.strip()
        clone_blob = query(target, "SELECT encode(lo_get(id), 'hex') FROM blob_links;", role=task).stdout.strip()
        copied_token = query(target, "SELECT bool_and(synthetic_token = 'fixture-not-a-real-token') FROM seed;", role=task).stdout.strip()
        sequence = query(target, 'SELECT last_value FROM seed_id_seq;', role=task).stdout.strip()
        role_flags = query(target, "SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication FROM pg_roles WHERE rolname=current_user;", role=task).stdout.strip()
        query(target, 'BEGIN; ALTER TABLE seed ADD COLUMN reviewed boolean NOT NULL DEFAULT false; UPDATE seed SET reviewed=true; COMMIT;', role=task)
        failed_migration = query(target, 'BEGIN; ALTER TABLE seed ADD COLUMN rollback_marker integer; SELECT 1/0; COMMIT;', role=task, check=False)
        rollback_absent = query(target, "SELECT count(*) FROM information_schema.columns WHERE table_name='seed' AND column_name='rollback_marker';", role=task).stdout.strip() == '0'
        query(target, 'TRUNCATE seed RESTART IDENTITY;', role=task)
        after_reset = query(target, 'SELECT count(*) FROM seed;', role=task).stdout.strip()
        source_after = query(source, 'SELECT md5(string_agg(row_to_json(seed)::text, E\'\\n\' ORDER BY id)) FROM seed;').stdout.strip()
        source_no_migration = query(source, "SELECT count(*) FROM information_schema.columns WHERE table_name='seed' AND column_name IN ('reviewed','rollback_marker');").stdout.strip() == '0'
        if require_vector:
            vector_report['sourceVectorsUnchangedByTaskOperations'] = query(source, 'SELECT id,embedding::text FROM embeddings ORDER BY id;').stdout == source_vectors
            if vector_report['sourceVectorsUnchangedByTaskOperations'] is not True:
                raise RuntimeError('Synthetic source vectors changed unexpectedly.')
        other_database = query('postgres', 'SELECT current_database();', role=task, check=False)
        query('postgres', f'DROP DATABASE {target};')
        report = {
            'scope': 'New local synthetic cluster only; no Vela database connection or data.',
            'pgvector': vector_report,
            'version': version,
            'transport': 'Private Unix socket; TCP listen_addresses empty; SCRAM passwords generated per run.',
            'publicConnectSurvivesRoleRevoke': inherited_connect.returncode == 0,
            'sourceTableReadBeforeHardeningExit': source_table_read.returncode,
            'sourceConnectAfterPublicRevokeExit': denied_source.returncode,
            'snapshotCloneRows': int(clone_rows),
            'sourceRowsAfterDeliberateSyntheticWriter': int(source_rows),
            'clonedViewCount': int(clone_view),
            'clonedLargeObjectHex': clone_blob,
            'clonedSequenceLastValue': int(sequence),
            'syntheticCredentialCopied': copied_token == 't',
            'taskRoleFlagsSuperuserCreateDbCreateRoleReplication': role_flags,
            'failedMigrationExit': failed_migration.returncode,
            'failedMigrationRolledBack': rollback_absent,
            'taskResetRowCount': int(after_reset),
            'sourceRowsUnchangedByTaskMigrationAndReset': source_baseline == source_after,
            'sourceSchemaUnchangedByTaskMigration': source_no_migration,
            'defaultOtherDatabaseConnectExit': other_database.returncode,
            'defaultOtherDatabaseConnectRemainsAllowed': other_database.returncode == 0,
            'archiveSha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
            'taskDatabaseDropped': True,
            'limitation': 'SQL-role tests only. Same Unix UID owns cluster and generated admin credentials; not an agent isolation boundary. Database gateway denial and real client migration tooling are separate tests.',
        }
    finally:
        try:
            if exporter is not None and exporter.poll() is None:
                exporter.terminate()
                exporter.communicate(timeout=5)
        finally:
            if started or (data / 'postmaster.pid').exists():
                run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'])
    invariants = [
        report['snapshotCloneRows'] == 2, report['sourceRowsAfterDeliberateSyntheticWriter'] == 3,
        report['clonedViewCount'] == 2, report['clonedLargeObjectHex'] == '66697874757265',
        report['syntheticCredentialCopied'], report['taskRoleFlagsSuperuserCreateDbCreateRoleReplication'] == 'f|f|f|f',
        report['failedMigrationExit'] != 0, report['failedMigrationRolledBack'], report['taskResetRowCount'] == 0,
        report['sourceRowsUnchangedByTaskMigrationAndReset'], report['sourceSchemaUnchangedByTaskMigration'],
        report['sourceTableReadBeforeHardeningExit'] != 0, report['sourceConnectAfterPublicRevokeExit'] != 0,
    ]
    if not all(invariants):
        raise RuntimeError('Synthetic database invariants failed; this is not a passing probe.')
    report['pass'] = True
    report['clusterStoppedAndTemporaryDataRemovedOnExit'] = True
print(json.dumps(report, indent=2))
