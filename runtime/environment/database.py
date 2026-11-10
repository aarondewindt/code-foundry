"""Trusted persistent synthetic PostgreSQL 18 fixture. No existing cluster input."""
import json
import os
from pathlib import Path
import secrets
import re
import signal
import subprocess
import time
import sys

ROOT = Path('/var/lib/postgresql')
CONTROL = Path('/control')
BIN = Path('/usr/lib/postgresql/18/bin')
OWNER = os.environ['CF_OWNER']
assert os.getuid() != 0
assert len(OWNER) == 36
ADMIN = 'cf_supervisor'
ROLE = 'cf_task'
SOURCE = 'cf_source'
TARGET = 'cf_taskdb'
SHADOW = 'cf_shadowdb'
SOCKET = ROOT / 'backend'
SOCKET.mkdir(mode=0o700, exist_ok=True)
ENV = {'PATH': os.environ['PATH'], 'LC_ALL': 'C', 'PGCONNECT_TIMEOUT': '3'}
PASSWORDS = ROOT / 'passwords.json'
if '--check' in sys.argv and not PASSWORDS.exists():
    raise RuntimeError('Missing persistent credentials')
if not PASSWORDS.exists():
    PASSWORDS.write_text(json.dumps({'admin': secrets.token_urlsafe(32), 'task': secrets.token_urlsafe(32)}))
    PASSWORDS.chmod(0o600)
passwords = json.loads(PASSWORDS.read_text())

def run(binary, args, sql=None, role=ADMIN):
    result = subprocess.run([str(BIN / binary), *map(str, args)], input=sql, text=True,
                            capture_output=True, timeout=60,
                            env={**ENV, 'PGPASSWORD': passwords['admin' if role == ADMIN else 'task']})
    if result.returncode:
        raise RuntimeError('Synthetic database operation failed: ' + binary)
    return result.stdout.strip()

def query(database, sql, role=ADMIN):
    return run('psql', ['-XqAt', '-v', 'ON_ERROR_STOP=1', '-h', SOCKET, '-p', '55432', '-U', role, '-d', database, '-w'], sql, role)

def inventory(database):
    return json.loads(query(database, """SELECT json_build_object(
      'rows',(SELECT json_agg(t ORDER BY id) FROM source_fixture t),
      'vectors',(SELECT json_agg(embedding::text ORDER BY id) FROM source_fixture),
      'tables',(SELECT count(*) FROM information_schema.tables WHERE table_schema='public'),
      'indexes',(SELECT count(*) FROM pg_indexes WHERE schemaname='public'),
      'sequence',(SELECT last_value FROM fixture_sequence),
      'largeObjects',(SELECT count(*) FROM pg_largeobject_metadata),
      'largeObjectContents',(SELECT json_agg(encode(data,'hex') ORDER BY loid,pageno) FROM pg_largeobject),
      'indexDefinitions',(SELECT json_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname='public'),
      'schemaInventory',(SELECT json_agg(json_build_array(relkind::text,relname) ORDER BY relkind,relname)
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'),
      'viewRows',(SELECT count(*) FROM fixture_view),
      'vectorVersion',(SELECT extversion FROM pg_extension WHERE extname='vector'))"""))

def ownership():
    return json.loads(query('postgres', f"""SELECT json_build_object('owner','{OWNER}',
       'roleOid',(SELECT oid FROM pg_roles WHERE rolname='{ROLE}'),
       'databases',(SELECT json_agg(json_build_object('name',datname,'oid',oid,'ownerOid',datdba) ORDER BY datname)
         FROM pg_database WHERE datname IN ('{SOURCE}','{TARGET}','{SHADOW}')),
       'version',current_setting('server_version_num'))"""))

if '--check' in sys.argv:
    recorded = json.loads((ROOT / 'initialized.json').read_text())
    assert recorded['identity'] == ownership()
    assert recorded['sourceInventory'] == inventory(SOURCE)
    assert query('postgres', "SELECT NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid) FROM pg_roles WHERE rolname='cf_task'") == 't'
    print(json.dumps(recorded))
    raise SystemExit(0)

# Any interrupted initialization is retained and refused rather than replayed.
marker = ROOT / 'initialized.json'
data = ROOT / 'data'
if not marker.exists() and data.exists():
    raise RuntimeError('Partial cluster retained; explicit supervisor reconciliation required')
if not data.exists():
    pwfile = ROOT / 'init-password'
    pwfile.write_text(passwords['admin'])
    pwfile.chmod(0o600)
    run('initdb', ['-D', data, '-U', ADMIN, '--pwfile', pwfile, '--auth-local=scram-sha-256', '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
run('pg_ctl', ['-D', data, '-l', ROOT / 'postgres.log', '-o', f"-k {SOCKET} -h '' -p 55432 -c max_connections=20 -c shared_buffers=16MB", '-w', 'start'])
bouncer = None
try:
    version = int(query('postgres', 'SHOW server_version_num'))
    assert 180000 <= version < 190000
    if not marker.exists():
        query('postgres', f"CREATE ROLE {ROLE} LOGIN PASSWORD '{passwords['task']}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 8;")
        query('postgres', f'CREATE DATABASE {SOURCE} TEMPLATE template0;')
        query(SOURCE, """CREATE EXTENSION vector;
            CREATE TABLE source_fixture(id integer PRIMARY KEY, embedded_token text, embedding vector(3));
            INSERT INTO source_fixture VALUES (1,'invented-no-authority-token','[1,2,3]'),(2,'synthetic-secret','[3,2,1]');
            CREATE INDEX fixture_hnsw ON source_fixture USING hnsw(embedding vector_l2_ops);
            CREATE SEQUENCE fixture_sequence START 7;
            SELECT nextval('fixture_sequence');
            CREATE VIEW fixture_view AS SELECT id FROM source_fixture;
            SELECT lo_from_bytea(0, decode('010203','hex'));""")
        original = inventory(SOURCE)
        assert original['vectorVersion'] == '0.8.7'
        # pg_dump's complete single-transaction snapshot includes all schemas/data/LOs.
        dump = ROOT / 'snapshot.dump'
        run('pg_dump', ['-h', SOCKET, '-p', '55432', '-U', ADMIN, '-d', SOURCE, '-w', '-Fc', '--lock-wait-timeout=5s', '-f', dump])
        dump.chmod(0o600)
        for database in [TARGET, SHADOW]:
            query('postgres', f'CREATE DATABASE {database} OWNER {ROLE} TEMPLATE template0;')
            query('postgres', f'REVOKE ALL ON DATABASE {database} FROM PUBLIC;')
            query(database, f'GRANT USAGE, CREATE ON SCHEMA public TO {ROLE}; CREATE EXTENSION vector;')
        toc = run('pg_restore', ['--list', dump])
        selected = []
        skipped = 0
        for line in toc.splitlines():
            if re.match(r'^\d+; \d+ \d+ (?:EXTENSION - vector|COMMENT - EXTENSION vector)(?:\s|$)', line):
                skipped += 1
                continue
            selected.append(line)
        assert skipped == 2
        restore_list = ROOT / 'restore.list'
        restore_list.write_text('\n'.join(selected) + '\n')
        run('pg_restore', ['-h', SOCKET, '-p', '55432', '-U', ROLE, '-d', TARGET, '-w', '--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', '--use-list', restore_list, dump], role=ROLE)
        clone = inventory(TARGET)
        assert original == clone
        identity = ownership()
        role_oid = identity['roleOid']
        assert all(db['ownerOid'] == role_oid for db in identity['databases'] if db['name'] != SOURCE)
        assert len(identity['databases']) == 3
        marker.write_text(json.dumps({'identity': identity, 'sourceInventory': original, 'cloneInventory': clone}))
        marker.chmod(0o600)
    recorded = json.loads(marker.read_text())
    assert recorded['identity'] == ownership()
    assert recorded['sourceInventory'] == inventory(SOURCE)
    config = ROOT / 'pgbouncer.ini'
    users = ROOT / 'users.txt'
    users.write_text(f'"{ROLE}" "{passwords["task"]}"\n')
    users.chmod(0o600)
    config.write_text(f'''[databases]
{TARGET} = host={SOCKET} port=55432 dbname={TARGET} user={ROLE} password={passwords['task']}
{SHADOW} = host={SOCKET} port=55432 dbname={SHADOW} user={ROLE} password={passwords['task']}
[pgbouncer]
listen_addr =
listen_port = 6432
unix_socket_dir = /frontend
unix_socket_mode = 0666
auth_type = scram-sha-256
auth_file = {users}
pool_mode = session
max_client_conn = 8
default_pool_size = 2
server_connect_timeout = 3
query_wait_timeout = 5
query_timeout = 15
admin_users =
stats_users =
log_connections = 0
log_disconnections = 0
''')
    config.chmod(0o600)
    bouncer = subprocess.Popen(['pgbouncer', str(config)], env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.monotonic() + 10
    while not Path('/frontend/.s.PGSQL.6432').exists():
        assert bouncer.poll() is None and time.monotonic() < deadline
        time.sleep(.05)
    # Only task-scoped credentials leave the backend; no admin key or dump.
    (CONTROL / 'client.json').write_text(json.dumps({'user': ROLE, 'password': passwords['task'], 'database': TARGET, 'shadow': SHADOW}))
    (CONTROL / 'client.json').chmod(0o644)
    (CONTROL / 'ready.json').write_text(json.dumps({**recorded, 'serviceUid': os.getuid(), 'ready': True}))
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    while True:
        assert bouncer.poll() is None
        time.sleep(.2)
except KeyboardInterrupt:
    pass
finally:
    if bouncer:
        bouncer.terminate()
        bouncer.wait(timeout=5)
    run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'])
