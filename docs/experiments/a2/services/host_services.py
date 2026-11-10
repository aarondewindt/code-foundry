"""Host-only A2 service-enabled feasibility trial; synthetic resources only."""

import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import runpy
import secrets
import subprocess
import tempfile
import threading

from model_gateway import ModelGateway


def main(export):
    repo = Path(__file__).resolve().parents[4]
    helpers = runpy.run_path(str(repo / 'docs/experiments/a2/host-followup.py'))
    command = helpers['command']
    restricted = helpers['restricted']
    runtime = helpers['host_runtime']
    run_container = helpers['run_container']
    wait_for = helpers['wait_for']
    if os.getuid() == 0:
        raise RuntimeError('Run as the non-root Ubuntu developer with existing Docker access')
    if command(['docker', 'info', '--format', '{{.OSType}}']).stdout.strip() != 'linux':
        raise RuntimeError('A Linux Docker engine is required')
    previous = json.loads((export / 'followup.json').read_text())
    if previous.get('complete') is not True:
        raise RuntimeError('Complete the previous host follow-up first')
    for path, digest in json.loads((export / 'probe-sha256.json').read_text()).items():
        if path not in ['docs/experiments/a2/host-followup.py', 'docs/experiments/a2/database-probe.py',
                        'docs/experiments/a2/pgvector-probe.Dockerfile', 'docs/experiments/a2/process-writers.py']:
            raise RuntimeError('Unexpected previous probe path')
        if hashlib.sha256((repo / path).read_bytes()).hexdigest() != digest:
            raise RuntimeError('Previous probe source has changed; review evidence before continuing')
    worker_base = previous['imageId']
    database_base = previous['database']['imageId']
    for image in [worker_base, database_base]:
        if not re.fullmatch(r'sha256:[0-9a-f]{64}', image):
            raise RuntimeError('Expected immutable local base image IDs')
        command(['docker', 'image', 'inspect', '--format', '{{.Id}}', image])
    root = Path(tempfile.mkdtemp(prefix='code-foundry-a2-services-')).resolve()
    print(f'Evidence directory: {root}', flush=True)
    report = {'complete': False, 'scope': 'A2 synthetic service-enabled trial; no Vela or existing DB access',
              'containers': [], 'model': 'gpt-oss:20b', 'checks': {}}
    for name in ['control', 'db-gateway', 'model-gateway', 'task', 'shared', 'retry']:
        (root / name).mkdir()
    # Separate trusted service identity can create only its generated control/socket files.
    (root / 'control').chmod(0o777)
    (root / 'db-gateway').chmod(0o777)
    (root / 'shared/attachment.txt').write_text('synthetic attachment\n')
    sources = list(Path(__file__).parent.glob('*.py')) + [Path(__file__).parent / 'services.Dockerfile']
    (root / 'probe-sha256.json').write_text(json.dumps({str(p.relative_to(repo)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sources}, indent=2) + '\n')
    database_id = None
    model_gateway = None
    mock = None
    mock_thread = None
    model_counters = None
    try:
        # BuildKit resolves named local images consistently; bare sha256 IDs can
        # be parsed as registry references in FROM. Add unique, recorded aliases
        # without changing or replacing either verified base image.
        aliases = {}
        for target, image in [('worker', worker_base), ('database', database_base)]:
            alias = f'code-foundry-a2-{target}-base:{root.name}'
            if command(['docker', 'image', 'inspect', '--format', '{{.Id}}', alias], check=False).returncode == 0:
                raise RuntimeError('Refusing to overwrite an existing fixture image alias')
            command(['docker', 'image', 'tag', image, alias])
            aliases[target] = alias
        report['baseImageAliases'] = aliases
        images = {}
        for target in ['worker', 'database']:
            image_file = root / f'{target}-image-id'
            built = command(['docker', 'build', '--target', target, '--iidfile', image_file,
                             '--build-arg', f'A2_WORKER_BASE={aliases["worker"]}', '--build-arg', f'A2_DATABASE_BASE={aliases["database"]}',
                             '--file', repo / 'docs/experiments/a2/services/services.Dockerfile',
                             repo / 'docs/experiments/a2/services'], timeout=600)
            (root / f'{target}-build.log').write_text(built.stdout + built.stderr)
            images[target] = image_file.read_text().strip()
        for target, original in [('worker', worker_base), ('database', database_base)]:
            if command(['docker', 'image', 'inspect', '--format', '{{.Id}}', aliases[target]]).stdout.strip() != original:
                raise RuntimeError('Fixture base image alias changed during build')
        report['images'] = images
        backend_name = f'cf-a2-db-services-{root.name}'
        backend_args = [*restricted(backend_name, root), '--mount', f'type=bind,source={root}/control,target=/control',
                        '--mount', f'type=bind,source={root}/db-gateway,target=/frontend',
                        '--mount', f'type=bind,source={repo}/docs/experiments/a2/services,target=/probes,readonly',
                        '--tmpfs', '/var/lib/postgresql:rw,nosuid,nodev,noexec,size=16m,mode=1777', images['database']]
        backend_args[1] = 'create'
        database_id = command(backend_args).stdout.strip()
        if not re.fullmatch(r'[0-9a-f]{64}', database_id):
            raise RuntimeError('Expected immutable backend container ID')
        report['containers'].append(database_id)
        command(['docker', 'start', database_id])
        ready = root / 'control/ready.json'
        wait_for(lambda: ready.exists() and ready.stat().st_size > 0, seconds=30)
        state = json.loads(ready.read_text())
        # PgBouncer reserves peer-UID access to its admin identity. The worker must differ.
        if state['serviceUid'] == os.getuid():
            raise RuntimeError('Worker UID equals PgBouncer UID; peer-admin isolation is not established')
        report['databaseService'] = state
        report['checks']['differentWorkerAndDatabaseServiceUid'] = True
        # Only the synthetic task role credential is copied into its writable task root.
        client = json.loads((root / 'control/task-client.json').read_text())
        token = secrets.token_urlsafe(24)
        effects = []
        class MockSideEffect(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass
            def do_POST(self):
                if effects or self.path != '/effect' or self.headers.get('Authorization') != f'Bearer {token}':
                    self.send_response(403)
                else:
                    effects.append('explicitly-approved-synthetic-effect')
                    self.send_response(204)
                self.end_headers()
        mock = http.server.ThreadingHTTPServer(('127.0.0.1', 0), MockSideEffect)
        mock_thread = threading.Thread(target=mock.serve_forever, daemon=True)
        mock_thread.start()
        # Explicit separate supervised process; token goes only through stdin, not worker env/argv.
        # Separate process receives its narrowly scoped mock capability only via stdin.
        manual = subprocess.run(['python3', '-c',
            "import sys,json,urllib.request; p=json.load(sys.stdin); r=urllib.request.Request('http://127.0.0.1:'+str(p['port'])+'/effect',data=b'',headers={'Authorization':'Bearer '+p['token']}); print(urllib.request.urlopen(r,timeout=3).status)"],
            input=json.dumps({'port': mock.server_port, 'token': token}),
            env={'PATH': os.environ['PATH'], 'LC_ALL': 'C'}, text=True, capture_output=True, timeout=5)
        if manual.returncode != 0 or manual.stdout.strip() != '204' or len(effects) != 1:
            raise RuntimeError('Separate supervised mock action failed')
        report['checks']['separateSupervisedMockActionSucceeded'] = True
        model_gateway = ModelGateway(root / 'model-gateway/ollama.sock', report['model'], request_budget=32)
        client.update({'model': report['model'], 'mockPort': mock.server_port})
        (root / 'task/task-client.json').write_text(json.dumps(client))
        (root / 'task/task-client.json').chmod(0o600)
        worker_name = f'cf-a2-service-worker-{root.name}'
        worker_args = [*restricted(worker_name, root), '--user', f'{os.getuid()}:{os.getgid()}',
                       '--mount', f'type=bind,source={root}/task,target=/task',
                       '--mount', f'type=bind,source={root}/shared,target=/shared,readonly,bind-recursive=disabled',
                       '--mount', f'type=bind,source={root}/db-gateway,target=/gateways/db,readonly',
                       '--mount', f'type=bind,source={root}/model-gateway,target=/gateways/model,readonly',
                       '--mount', f'type=bind,source={repo}/docs/experiments/a2/services,target=/probes,readonly',
                       '--workdir', '/task', images['worker'], 'python3', '/probes/worker_probe.py']
        worker = run_container(worker_args, timeout=300, check=False)
        (root / 'worker.stdout').write_text(worker.stdout)
        (root / 'worker.stderr').write_text(worker.stderr)
        worker_runtime = runtime(worker_name)
        report['workerRuntime'] = worker_runtime
        report['containers'].append(worker_runtime['id'])
        evidence_path = root / 'task/worker-results.json'
        if not evidence_path.exists():
            raise RuntimeError('Worker did not produce results; retain worker.stderr')
        evidence = json.loads(evidence_path.read_text())
        if worker.returncode or not evidence.get('pass') or not evidence.get('complete') or worker_runtime['exitCode'] != 0:
            raise RuntimeError('Worker service/model trial failed; retain all evidence')
        report['checks']['workerServiceAndModelTrialPassed'] = True
        # Retry has no model tools, developer credentials or supervised side-effect capability.
        retry_name = f'cf-a2-service-retry-{root.name}'
        retry_code = (
            "import http.client,json,os,socket,sys; "
            "sys.path.insert(0,'/probes'); from model_gateway import LoopbackAdapter; "
            "a=LoopbackAdapter('/gateways/model/ollama.sock'); "
            "c=http.client.HTTPConnection('127.0.0.1',4111,timeout=3); "
            "c.request('POST','/effect',b''); r=c.getresponse(); assert r.status==403; r.read(); "
            "assert not any(os.environ.get(k) for k in ['GH_TOKEN','GITHUB_TOKEN','OPENAI_API_KEY','SUPERVISED_TOKEN']); "
            "print(json.dumps({'supervisedRouteDeniedOnRetry':True,'noInheritedCapability':True})); a.close()"
        )
        retried = run_container([*restricted(retry_name, root), '--user', f'{os.getuid()}:{os.getgid()}',
                                '--mount', f'type=bind,source={root}/retry,target=/task',
                                '--mount', f'type=bind,source={root}/model-gateway,target=/gateways/model,readonly',
                                '--mount', f'type=bind,source={repo}/docs/experiments/a2/services,target=/probes,readonly',
                                '--workdir', '/task', images['worker'], 'python3', '-c', retry_code], timeout=15)
        report['retry'] = json.loads(retried.stdout)
        report['retryRuntime'] = runtime(retry_name)
        report['containers'].append(report['retryRuntime']['id'])
        report['checks']['mockExternalStateUnchangedDuringWorkerAndRetry'] = len(effects) == 1
        report['checks']['sharedAttachmentUnchanged'] = (root / 'shared/attachment.txt').read_text() == 'synthetic attachment\n'
        (root / 'control/finish').touch()
        command(['docker', 'wait', database_id], timeout=20)
        final_database = json.loads((root / 'control/database-final.json').read_text())
        report['databaseFinal'] = final_database
        report['databaseRuntime'] = runtime(database_id)
        report['checks']['sourceUnchangedThroughGateway'] = all(final_database.values())
        report['checks']['databaseServiceStopped'] = report['databaseRuntime']['status'] == 'exited' and report['databaseRuntime']['exitCode'] == 0
        report['checks']['modelTrafficReachedFixedUpstream'] = model_gateway.counters['accepted'] > 0 and model_gateway.counters['upstreamErrors'] == 0
        model_counters = dict(model_gateway.counters)
        if not all(report['checks'].values()):
            raise RuntimeError('Host service invariants failed')
        report['complete'] = True
    finally:
        cleanup_errors = []
        try:
            if database_id and runtime(database_id)['running']:
                command(['docker', 'stop', '--time', '5', database_id], timeout=15)
        except Exception:
            cleanup_errors.append('Could not confirm database service termination')
        try:
            if model_gateway:
                report['modelGatewayCounters'] = model_counters or dict(model_gateway.counters)
                model_gateway.close()
        except Exception:
            cleanup_errors.append('Could not confirm model gateway shutdown')
        try:
            if mock:
                mock.shutdown()
                mock.server_close()
                mock_thread.join(timeout=2)
        except Exception:
            cleanup_errors.append('Could not confirm mock service shutdown')
        report['cleanupErrors'] = cleanup_errors
        if cleanup_errors:
            report['complete'] = False
        (root / 'services.json').write_text(json.dumps(report, indent=2) + '\n')
        print(f'Retained evidence: {root}', flush=True)
        if cleanup_errors:
            raise RuntimeError('; '.join(cleanup_errors))
    print('Copy the printed directory into scratch for review. Do not delete retained containers or evidence yet.', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('followup_export', type=Path)
    args = parser.parse_args()
    main(args.followup_export.resolve())
