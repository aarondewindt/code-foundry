"""Run only in the proposed Docker profile against /task and synthetic /shared fixtures."""

import errno
import json
import os
from pathlib import Path
import socket

checks = {}
checks['nonRoot'] = os.getuid() != 0
status = dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
checks['noEffectiveCapabilities'] = int(status['CapEff'].strip(), 16) == 0
checks['noBoundingCapabilities'] = int(status['CapBnd'].strip(), 16) == 0
checks['noNewPrivileges'] = status['NoNewPrivs'].strip() == '1'
checks['seccompFilterPresent'] = status['Seccomp'].strip() == '2'
checks['rootMountReadOnly'] = any(line.split()[4] == '/' and 'ro' in line.split()[5].split(',')
                                  for line in Path('/proc/self/mountinfo').read_text().splitlines())
checks['onlyLoopbackNetwork'] = sorted(p.name for p in Path('/sys/class/net').iterdir()) == ['lo']
checks['noDockerSocket'] = not Path('/var/run/docker.sock').exists()
checks['noDeveloperCredentialMounts'] = all(not Path(p).exists() for p in [
    '/home/node/.config/gh/hosts.yml', '/home/node/.ssh', '/home/node/.codex',
])
checks['noInheritedCredentialEnvironment'] = all(not os.environ.get(key) for key in [
    'GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'PGPASSWORD', 'DATABASE_URL',
    'AWS_ACCESS_KEY_ID', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
])
for name, expected in [('memory.max', '4294967296'), ('pids.max', '128'), ('cpu.max', '200000 100000'), ('memory.swap.max', '0')]:
    path = Path('/sys/fs/cgroup') / name
    checks[f'limit:{name}'] = path.exists() and path.read_text().strip() == expected

Path('/task/probe-output.txt').write_text('synthetic task output\n')
checks['taskWriteAllowed'] = Path('/task/probe-output.txt').read_text() == 'synthetic task output\n'
checks['sharedReadAllowed'] = Path('/shared/attachment.txt').read_text() == 'synthetic attachment\n'

def denied(action):
    try:
        action()
        return False
    except OSError as error:
        return error.errno in [errno.EROFS, errno.EACCES, errno.EPERM]

checks['rootWriteDenied'] = denied(lambda: Path('/home/node/a2-forbidden').write_text('fixture'))
checks['sharedWriteDenied'] = denied(lambda: Path('/shared/attachment.txt').write_text('fixture'))
checks['sharedChmodDenied'] = denied(lambda: Path('/shared/attachment.txt').chmod(0o600))
checks['sharedDeleteDenied'] = denied(lambda: Path('/shared/attachment.txt').unlink())
link = Path('/task/link-to-shared')
link.symlink_to('/shared/attachment.txt')
checks['symlinkWriteDenied'] = denied(lambda: link.write_text('fixture'))
for family, address in [(socket.AF_INET, ('192.0.2.1', 443)), (socket.AF_INET6, ('2001:db8::1', 443))]:
    try:
        with socket.socket(family, socket.SOCK_STREAM) as connection:
            connection.settimeout(1)
            connection.connect(address)
        checks[f'networkDenied:{family.name}'] = False
    except OSError as error:
        checks[f'networkDenied:{family.name}'] = error.errno in [errno.ENETUNREACH, errno.EAFNOSUPPORT, errno.EPERM, errno.EACCES]
print(json.dumps({'checks': checks, 'pass': all(checks.values()),
                  'scope': 'Filesystem/process/resource/offline gate only; no Ollama or database gateway tested.'}, indent=2))
raise SystemExit(0 if all(checks.values()) else 1)
