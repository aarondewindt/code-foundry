"""Inspect metadata and attack disposable same-UID fixtures; never read real secrets."""

import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.request import Request, urlopen

status = dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
report = {
    'meaning': 'Completed probes are evidence, not a passing security gate.',
    'uid': os.getuid(),
    'process': {key: status[key].strip() for key in ['CapEff', 'CapBnd', 'NoNewPrivs', 'Seccomp']},
    'tools': {key: bool(shutil.which(key)) for key in ['docker', 'podman', 'bwrap', 'unshare', 'psql', 'postgres']},
    'environmentPresent': {key: bool(os.environ.get(key)) for key in [
        'GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'DOCKER_HOST', 'DATABASE_URL',
        'PGPASSWORD', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
    ]},
    'paths': {},
    'cgroup': {},
    'probes': {},
}
for label, path in {
    'githubConfig': Path.home() / '.config/gh/hosts.yml',
    'gitConfig': Path.home() / '.gitconfig',
    'sshDirectory': Path.home() / '.ssh',
    'codexDirectory': Path.home() / '.codex',
    'dockerSocket': Path('/var/run/docker.sock'),
    'rootlessDockerSocket': Path('/run/user/1000/docker.sock'),
}.items():
    report['paths'][label] = {'exists': path.exists(), 'readable': os.access(path, os.R_OK)}
sock = os.environ.get('SSH_AUTH_SOCK')
report['sshSocketPresent'] = bool(sock and Path(sock).is_socket())
for name in ['cpu.max', 'memory.max', 'memory.swap.max', 'pids.max']:
    path = Path('/sys/fs/cgroup') / name
    report['cgroup'][name] = path.read_text().strip() if path.exists() else 'unavailable'
report['gpuDevicesPresent'] = bool(list(Path('/dev').glob('nvidia*'))) or Path('/dev/dri').exists()
report['mounts'] = []
for line in Path('/proc/self/mountinfo').read_text().splitlines():
    left, right = line.split(' - ', 1)
    fields = left.split()
    target = fields[4]
    if target in ['/', '/workspaces/code-foundry', '/home/node/.cache/yarn', '/home/node/.cache/node-gyp', '/sys/fs/cgroup']:
        report['mounts'].append({'target': target, 'filesystem': right.split()[0], 'readOnly': 'ro' in fields[5].split(',')})

with tempfile.TemporaryDirectory(prefix='code-foundry-a2-shared-') as tmp:
    root = Path(tmp)
    task = root / 'task'
    protected = root / 'protected'
    task.mkdir()
    protected.mkdir()
    attachment = protected / 'attachment.txt'
    attachment.write_text('synthetic original')
    child = subprocess.run([sys.executable, '-c',
        "from pathlib import Path; Path('../protected/attachment.txt').write_text('synthetic changed')"],
        cwd=task, capture_output=True, timeout=10)
    report['probes']['outsideTaskWrite'] = {'exit': child.returncode, 'permitted': attachment.read_text() == 'synthetic changed'}
    (task / 'link').symlink_to(attachment)
    (task / 'link').write_text('synthetic symlink write')
    report['probes']['symlinkOutsideTaskWrite'] = attachment.read_text() == 'synthetic symlink write'
    attachment.chmod(0o444)
    try:
        attachment.write_text('unexpected')
        report['probes']['mode0444WriteDenied'] = False
    except PermissionError:
        report['probes']['mode0444WriteDenied'] = True
    attachment.chmod(0o600)
    attachment.write_text('owner can restore writes')
    report['probes']['ownerCanUndoModeRestriction'] = True
    attachment.unlink()
    report['probes']['sharedFixtureDeletionPermitted'] = not attachment.exists()
    credential = protected / 'synthetic-token'
    credential.write_text('fixture-only-not-a-real-token')
    credential.chmod(0o600)
    clean_env = {'PATH': os.environ['PATH']}
    child = subprocess.run([sys.executable, '-c',
        "from pathlib import Path; assert Path('../protected/synthetic-token').read_text() == 'fixture-only-not-a-real-token'"],
        cwd=task, env=clean_env, capture_output=True, timeout=10)
    report['probes']['emptyEnvironmentStillReadsSameUidSyntheticCredential'] = child.returncode == 0
    sleeper = subprocess.Popen(['sleep', '30'])
    try:
        child = subprocess.run([sys.executable, '-c', 'import os,signal,sys; os.kill(int(sys.argv[1]),signal.SIGTERM)', str(sleeper.pid)],
                               capture_output=True, timeout=10)
        sleeper.wait(timeout=5)
        report['probes']['sameUidSiblingProcessSignalled'] = child.returncode == 0 and sleeper.returncode == -signal.SIGTERM
    finally:
        if sleeper.poll() is None:
            sleeper.terminate()
            sleeper.wait(timeout=5)
    if shutil.which('gh'):
        gh_env = dict(clean_env, GH_CONFIG_DIR=str(root / 'empty-gh'))
        child = subprocess.run(['gh', 'issue', 'view', '1', '--repo', 'aarondewindt/code-foundry', '--json', 'number'],
                               env=gh_env, capture_output=True, text=True, timeout=10)
        report['probes']['githubWithoutCredentials'] = {'exit': child.returncode, 'loginGuidance': 'gh auth login' in child.stderr}

class MockService(BaseHTTPRequestHandler):
    def do_POST(self):
        self.send_response(204)
        self.end_headers()

    def log_message(self, *_args):
        pass

server = HTTPServer(('127.0.0.1', 0), MockService)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    port = server.server_address[1]
    with urlopen(Request(f'http://127.0.0.1:{port}/repos/synthetic/fixture/issues', data=b'{}', method='POST'), timeout=5) as response:
        report['probes']['syntheticGithubStyleWrite'] = {'status': response.status, 'networkDenied': False, 'target': 'loopback fixture only'}
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)
if shutil.which('unshare'):
    child = subprocess.run(['unshare', '--user', '--map-root-user', '--net', 'true'], capture_output=True, text=True, timeout=5)
    report['probes']['childUserNetworkNamespace'] = {'exit': child.returncode, 'operationNotPermitted': 'Operation not permitted' in child.stderr}
if shutil.which('setpriv'):
    child = subprocess.run(['setpriv', '--no-new-privs', sys.executable, '-c',
        "from pathlib import Path; print(next(x for x in Path('/proc/self/status').read_text().splitlines() if x.startswith('NoNewPrivs:')))"],
        capture_output=True, text=True, timeout=5)
    report['probes']['childNoNewPrivileges'] = {'exit': child.returncode, 'enabled': child.stdout.strip().endswith('1')}
print(json.dumps(report, indent=2))
