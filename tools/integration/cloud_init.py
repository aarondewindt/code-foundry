"""Generate a credential-free cloud-config with a per-run public management key."""
import json


def configuration(public_key):
    return '#cloud-config\n' + json.dumps({
        'users': [{
            'name': 'cf', 'uid': 1000, 'groups': ['sudo', 'docker'],
            'shell': '/bin/bash', 'lock_passwd': True,
            'sudo': 'ALL=(ALL) NOPASSWD:ALL',
            'ssh_authorized_keys': [public_key.strip()],
        }],
        'disable_root': True,
        'ssh_pwauth': False,
        'apt': {
            'preserve_sources_list': False,
            'primary': [{'arches': ['default'], 'uri': 'http://archive.ubuntu.com/ubuntu'}],
            'security': [{'arches': ['default'], 'uri': 'http://security.ubuntu.com/ubuntu'}],
            'proxy': 'http://10.0.2.100:3128',
            'conf': 'Acquire::Retries "1"; Acquire::http::Timeout "30"; Acquire::http::Pipeline-Depth "0";',
        },
        'package_update': True,
        'packages': ['apparmor', 'busybox-static', 'docker.io', 'git', 'libatomic1', 'python3'],
        'runcmd': [
            ['systemctl', 'enable', '--now', 'apparmor', 'docker'],
            # Gate guest-only entry points; this is not host/deployment attestation.
            ['sh', '-c', 'echo code-foundry-disposable-v1 > /etc/code-foundry-disposable'],
        ],
    })
