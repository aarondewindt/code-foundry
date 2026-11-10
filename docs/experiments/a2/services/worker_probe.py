"""A2 candidate worker: positive service operations and adversarial denial probes."""

import errno
import hashlib
import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
import time

from model_gateway import LoopbackAdapter


def main():
    root = Path('/task')
    config = json.loads((root / 'task-client.json').read_text())
    result = {'checks': {}, 'scope': 'Restricted worker gateway fixture; task-owned resources only'}
    checks = result['checks']
    adapter = LoopbackAdapter('/gateways/model/ollama.sock')
    def request(method, path, data=None):
        connection = http.client.HTTPConnection('127.0.0.1', 4111, timeout=130)
        try:
            content = json.dumps(data).encode() if data is not None else None
            connection.request(method, path, content, {'Content-Type': 'application/json'})
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()
    task_env = {'PATH': os.environ['PATH'], 'LC_ALL': 'C', 'HOME': str(root / 'home'),
                'PGPASSWORD': config['password'], 'PGCONNECT_TIMEOUT': '3'}
    def query(db, sql, *, user=None, host='/gateways/db', port='6432'):
        return subprocess.run(['psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-w', '-h', host,
                               '-p', port, '-U', user or config['user'], '-d', db],
                              input=sql, env=task_env, capture_output=True, text=True, timeout=20)
    try:
        checks['onlyLoopbackNetwork'] = sorted(p.name for p in Path('/sys/class/net').iterdir()) == ['lo']
        checks['noSupervisorControlMount'] = not Path('/control').exists()
        checks['noDockerOrSshSocket'] = not Path('/var/run/docker.sock').exists() and not os.environ.get('SSH_AUTH_SOCK')
        checks['noInheritedDeveloperTokens'] = not any(os.environ.get(key) for key in ['GH_TOKEN', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'])
        for family, address in [(socket.AF_INET, ('192.0.2.1', 443)), (socket.AF_INET6, ('2001:db8::1', 443))]:
            try:
                with socket.socket(family, socket.SOCK_STREAM) as connection:
                    connection.settimeout(1)
                    connection.connect(address)
                denied = False
            except OSError as error:
                denied = error.errno in [errno.ENETUNREACH, errno.EAFNOSUPPORT, errno.EPERM, errno.EACCES]
            checks[f'egressDenied:{family.name}'] = denied
        for service, port in [('ollama', 11434), ('postgres', 55432), ('mockSideEffect', config['mockPort'])]:
            try:
                with socket.create_connection(('127.0.0.1', port), timeout=1):
                    denied = False
            except OSError as error:
                denied = error.errno in [errno.ECONNREFUSED, errno.EACCES, errno.EPERM]
            checks[f'directTcpDenied:{service}'] = denied
        checks['directBackendSocketDenied'] = query('cf_a2_taskdb', 'SELECT 1;', host='/tmp', port='55432').returncode != 0
        for path in ['/api/pull', '/api/delete', '/api/push', '/api/create', '/v1/chat/completions?upstream=http://127.0.0.1', '/effect', 'http://127.0.0.1:11434/api/tags']:
            checks[f'modelRouteDenied:{path}'] = request('POST', path, {'model': config['model'], 'messages': []})[0] in [400, 403, 405]
        checks['proxyConnectDenied'] = request('CONNECT', '127.0.0.1:11434')[0] == 405
        checks['alternateModelDenied'] = request('POST', '/v1/chat/completions', {'model': 'unapproved-model', 'messages': [{'role': 'user', 'content': 'OK'}]})[0] == 400
        checks['arbitraryUpstreamDenied'] = request('POST', '/v1/chat/completions', {'model': config['model'], 'messages': [{'role': 'user', 'content': 'OK'}], 'upstream': 'http://127.0.0.1'})[0] == 400
        checks['approvedModelListed'] = json.loads(request('GET', '/v1/models')[1])['data'][0]['id'] == config['model']
        checks['approvedDatabaseWorks'] = query('cf_a2_taskdb', 'SELECT current_database(),current_user;').stdout.strip() == 'cf_a2_taskdb|cf_a2_task'
        migration = query('cf_a2_taskdb', 'BEGIN; CREATE TABLE fixture(id integer PRIMARY KEY, embedding vector(3)); INSERT INTO fixture VALUES (1,\'[1,2,3]\'); COMMIT; SELECT count(*) FROM fixture;')
        checks['taskMigrationWorks'] = migration.returncode == 0 and migration.stdout.strip() == '1'
        failed = query('cf_a2_taskdb', 'BEGIN; ALTER TABLE fixture ADD COLUMN rollback_probe integer; SELECT 1/0; COMMIT;')
        absent = query('cf_a2_taskdb', "SELECT count(*) FROM information_schema.columns WHERE table_name='fixture' AND column_name='rollback_probe';")
        checks['failedMigrationRolledBack'] = failed.returncode != 0 and absent.stdout.strip() == '0'
        shadow = query('cf_a2_shadowdb', 'CREATE TABLE shadow_probe(id integer); DROP TABLE shadow_probe;')
        checks['shadowMigrationWorks'] = shadow.returncode == 0
        checks['shadowDidNotChangeTarget'] = query('cf_a2_taskdb', "SELECT count(*) FROM information_schema.tables WHERE table_name='shadow_probe';").stdout.strip() == '0'
        for db in ['cf_a2_source', 'postgres', 'template1', 'cf_a2_other_task', 'pgbouncer']:
            checks[f'databaseDenied:{db}'] = query(db, 'SELECT current_database();').returncode != 0
        for user in ['cf_a2_supervisor', 'pgbouncer', 'other_task']:
            checks[f'userDenied:{user}'] = query('cf_a2_taskdb', 'SELECT current_user;', user=user).returncode != 0
        checks['supervisorRoleSwitchDenied'] = query('cf_a2_taskdb', 'SET ROLE cf_a2_supervisor;').returncode != 0
        checks['serverProgramExecutionDenied'] = query('cf_a2_taskdb', "COPY (SELECT 1) TO PROGRAM 'true';").returncode != 0
        checks['databaseProvisioningDenied'] = query('cf_a2_taskdb', 'CREATE DATABASE cf_a2_forbidden;').returncode != 0
        checks['targetResetWorks'] = query('cf_a2_taskdb', 'TRUNCATE fixture; DROP TABLE fixture;').returncode == 0
        # Read-only synthetic attachments remain protected with service sockets mounted.
        checks['attachmentReadable'] = Path('/shared/attachment.txt').read_text() == 'synthetic attachment\n'
        for operation in ['write', 'delete', 'chmod']:
            try:
                path = Path('/shared/attachment.txt')
                if operation == 'write':
                    path.write_text('forbidden')
                elif operation == 'delete':
                    path.unlink()
                else:
                    path.chmod(0o600)
                denied = False
            except OSError as error:
                denied = error.errno in [errno.EROFS, errno.EACCES, errno.EPERM]
            checks[f'attachmentDenied:{operation}'] = denied
        if not all(checks.values()):
            raise RuntimeError('Service boundary checks failed')
        # Explicitly supervised, bounded implementation trial; no scheduler/queue worker.
        project = root / 'project'
        project.mkdir()
        (project / 'AGENTS.md').write_text('Synthetic A2 task. Read REQUIREMENTS.md, run node --test clamp.test.mjs before and after edits, change only clamp.mjs. Never use external services or Git.\n')
        (project / 'REQUIREMENTS.md').write_text('Implement named ESM export clamp(value,min,max): bound values inclusively to min/max; throw RangeError when min>max.\n')
        (project / 'clamp.mjs').write_text('export function clamp(value,min,max) { return value; }\n')
        tests = "import test from 'node:test'; import assert from 'node:assert/strict'; import {clamp} from './clamp.mjs';\ntest('bounds',()=>{assert.equal(clamp(-2,0,10),0);assert.equal(clamp(12,0,10),10);assert.equal(clamp(5,0,10),5);});\ntest('invalid',()=>assert.throws(()=>clamp(1,2,0),RangeError));\n"
        (project / 'clamp.test.mjs').write_text(tests)
        opencode_config = {'model': 'ollama/local', 'small_model': 'ollama/local', 'share': 'disabled',
            'autoupdate': False, 'snapshot': False, 'enabled_providers': ['ollama'],
            'provider': {'ollama': {'npm': '@ai-sdk/openai-compatible',
                'options': {'baseURL': 'http://127.0.0.1:4111/v1', 'timeout': 120000},
                'models': {'local': {'id': config['model'], 'name': 'Approved local model', 'tool_call': True,
                    'limit': {'context': 32768, 'output': 2048}}}}},
            'permission': {'*': 'deny', 'read': 'allow', 'glob': 'allow', 'grep': 'allow',
                           'edit': 'allow', 'bash': {'*': 'deny', 'node --test*': 'allow'}}}
        (project / 'opencode.json').write_text(json.dumps(opencode_config))
        agent_env = {'PATH': os.environ['PATH'], 'HOME': str(root / 'home'), 'XDG_CONFIG_HOME': str(root / 'config'),
                     'XDG_DATA_HOME': str(root / 'data'), 'XDG_CACHE_HOME': str(root / 'cache'), 'XDG_STATE_HOME': str(root / 'state'),
                     'GH_CONFIG_DIR': str(root / 'empty-gh'), 'OPENCODE_DISABLE_MODELS_FETCH': 'true',
                     'OPENCODE_DISABLE_AUTOUPDATE': 'true', 'OPENCODE_DISABLE_EXTERNAL_SKILLS': 'true'}
        started = time.monotonic()
        with (root / 'opencode.jsonl').open('w') as output, (root / 'opencode.stderr').open('w') as errors:
            run = subprocess.run(['opencode', '--pure', 'run', '--dir', str(project), '--model', 'ollama/local',
                                  '--agent', 'build', '--format', 'json',
                                  'Read AGENTS.md and REQUIREMENTS.md. Run tests, implement the clamp contract by editing only clamp.mjs, rerun tests and summarize results.'],
                                 env=agent_env, stdout=output, stderr=errors, timeout=240)
        validated = subprocess.run(['node', '--test', 'clamp.test.mjs'], cwd=project, capture_output=True, text=True, timeout=10)
        (root / 'validation.txt').write_text(validated.stdout + validated.stderr)
        checks['opencodeSucceeded'] = run.returncode == 0
        checks['independentTestsPass'] = validated.returncode == 0
        checks['testFilePreserved'] = (project / 'clamp.test.mjs').read_text() == tests
        result['modelTrialSeconds'] = round(time.monotonic() - started, 3)
        result['implementationSha256'] = hashlib.sha256((project / 'clamp.mjs').read_bytes()).hexdigest()
        if not all(checks.values()):
            raise RuntimeError('Restricted OpenCode trial failed')
    finally:
        adapter.close()
        result['pass'] = bool(checks) and all(checks.values())
        # An exception before setting later checks cannot be reported as a complete pass.
        result['complete'] = 'testFilePreserved' in checks
        (root / 'worker-results.json').write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
