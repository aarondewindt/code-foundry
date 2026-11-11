"""Bounded readiness probe only. Never starts OpenCode or project hooks."""
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys

root = Path(sys.argv[1])
base = sys.argv[2]
model = sys.argv[3]
client = json.loads((root / 'database.json').read_text())
checks = {}

def check(name, predicate):
    checks[name] = bool(predicate())
    if not checks[name]:
        raise RuntimeError('Readiness check failed: ' + name)

def denied(operation):
    try:
        operation()
    except (OSError, PermissionError):
        return True
    return False

def hidden_path(path):
    try:
        return not Path(path).exists()
    except PermissionError:
        # An inaccessible supervisor home is an expected boundary, not a probe error.
        return True

def connect(family, address):
    with socket.socket(family) as connection:
        connection.settimeout(1)
        connection.connect(address)

check('nonRoot', lambda: os.getuid() != 0)
check('apparmorEnforced', lambda: Path('/proc/self/attr/current').read_text().strip() == 'docker-default (enforce)')
status = Path('/proc/self/status').read_text()
check('noNewPrivileges', lambda: 'NoNewPrivs:\t1' in status)
check('seccompFilter', lambda: 'Seccomp:\t2' in status)
check('memoryLimit', lambda: Path('/sys/fs/cgroup/memory.max').read_text().strip() == '4294967296')
check('pidLimit', lambda: Path('/sys/fs/cgroup/pids.max').read_text().strip() == '128')
check('cpuLimit', lambda: Path('/sys/fs/cgroup/cpu.max').read_text().strip() == '200000 100000')
check('noCapabilities', lambda: 'CapEff:\t0000000000000000' in status)
check('searchToolInstalled', lambda: shutil.which('rg') is not None)
check('searchToolExecutable', lambda: subprocess.run(['rg', '--version'], capture_output=True, timeout=5).returncode == 0)
check('searchToolWorktree', lambda: subprocess.run(['rg', '--files', str(root/'worktree')], capture_output=True, timeout=5).returncode == 0)
check('noSupervisorCredentials', lambda: all(hidden_path(p) for p in ['/control', '/var/run/docker.sock', '/root/.ssh', '/home/node/.ssh', '/home/node/.config/gh', '/home/node/.codex']))
check('cleanEnvironment', lambda: not any(os.environ.get(k) for k in ['GH_TOKEN','GITHUB_TOKEN','SSH_AUTH_SOCK','OPENAI_API_KEY','DATABASE_URL']))
check('sourceAbsent', lambda: not Path(sys.argv[4]).exists())
check('ipv4Denied', lambda: denied(lambda: connect(socket.AF_INET, ('1.1.1.1',443))))
check('ipv6Denied', lambda: denied(lambda: connect(socket.AF_INET6, ('2606:4700:4700::1111',443))))
check('mockWritesDenied', lambda: denied(lambda: connect(socket.AF_INET, ('127.0.0.1',int(sys.argv[5])))))
attachment = Path('/shared/attachment.txt')
check('sharedReadable', lambda: attachment.read_text() == 'synthetic attachment\n')
check('sharedWriteDenied', lambda: denied(lambda: attachment.write_text('forbidden')))
check('sharedChmodDenied', lambda: denied(lambda: attachment.chmod(0o777)))
check('sharedDeleteDenied', lambda: denied(attachment.unlink))
for name, port in [('application',3000),('modelAdapter',4111)]:
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1',port))
        checks['portAvailable:'+name] = True
check('rootReadonly', lambda: denied(lambda: Path('/forbidden').write_text('forbidden')))
head = subprocess.check_output(['git','-C',str(root/'worktree'),'rev-parse','HEAD'],text=True).strip()
check('sameAbsoluteGitPaths', lambda: head == base and Path((root/'worktree/.git').read_text().strip()[8:]).is_dir())

def query(database, sql='SELECT current_database();', user=None):
    return subprocess.run(['psql','-XqAt','-w','-h','/gateways/db','-p','6432','-U',user or client['user'],'-d',database,'-v','ON_ERROR_STOP=1'],
       input=sql, capture_output=True,text=True,timeout=20,
       env={'PATH':os.environ['PATH'],'PGPASSWORD':client['password'],'PGCONNECT_TIMEOUT':'3'})

for database in [client['database'],client['shadow']]:
    check('databaseAccess:'+database, lambda: query(database).returncode == 0)
for database in ['cf_source','postgres','template1','other_task','pgbouncer']:
    check('databaseDenied:'+database, lambda: query(database).returncode != 0)
check('alternateIdentityDenied', lambda: query(client['database'],user='cf_supervisor').returncode != 0)
check('privilegedSqlDenied', lambda: query(client['database'],'CREATE ROLE forbidden SUPERUSER;').returncode != 0)
# Verify ownership before any migration/reset. Migrations remain transactional.
owner = query(client['database'], "SELECT datdba=(SELECT oid FROM pg_roles WHERE rolname=current_user) FROM pg_database WHERE datname=current_database();")
check('migrationOwnership', lambda: owner.returncode == 0 and owner.stdout.strip() == 't')
check('fixtureMigration', lambda: query(client['database'], 'BEGIN; ALTER TABLE source_fixture ADD COLUMN readiness_fixture integer; UPDATE source_fixture SET readiness_fixture=1; ROLLBACK;').returncode == 0)
check('shadowMigration', lambda: query(client['shadow'], 'BEGIN; CREATE TABLE readiness_shadow(id integer); ROLLBACK;').returncode == 0)

class UnixHTTP(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        self.sock.settimeout(3)
        self.sock.connect('/gateways/model/ollama.sock')

def request(method,path,value=None):
    connection = UnixHTTP('localhost',timeout=3)
    try:
        body = None if value is None else json.dumps(value)
        connection.request(method,path,body,{'Content-Type':'application/json'})
        response=connection.getresponse()
        result=(response.status,response.read(131072))
        return result
    finally:
        connection.close()
status, body = request('GET','/v1/models')
check('approvedModel', lambda: status==200 and [m['id'] for m in json.loads(body)['data']]==[model])
for path in ['/api/pull','/api/delete','/effect','http://127.0.0.1/effect']:
    check('modelRouteDenied:'+path, lambda: request('POST',path,{})[0] in [400,403,405])
check('otherModelDenied', lambda: request('POST','/v1/chat/completions',{'model':'forbidden','messages':[{'role':'user','content':'test'}]})[0] in [400,403])
print(json.dumps({'checks':checks,'ready':all(checks.values())}))
