"""Guest-only Docker compatibility probe using a locally imported BusyBox image."""
from hashlib import sha256
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import time


def docker(*args, seconds=30, data=None):
    result = subprocess.run(['docker', *args], input=data, capture_output=True,
                            timeout=seconds, env={'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent'})
    if result.returncode:
        raise RuntimeError('Guest Docker compatibility operation failed: ' + result.stderr[:8192].decode(errors='replace').strip())
    return result.stdout.decode().strip()


def main():
    report = {'complete': False, 'checks': {}, 'scope': 'Guest runtime compatibility only', 'stage': 'engine-preflight'}
    containers = []
    image = None
    root = Path(tempfile.mkdtemp(prefix='cf-smoke-', dir='/home/cf'))
    checks = report['checks']
    try:
        assert os.getuid() == 1000
        assert Path('/etc/code-foundry-disposable').read_text().strip() == 'code-foundry-disposable-v1'
        info = json.loads(docker('info', '--format', '{{json .}}'))
        assert info['OSType'] == 'linux' and info['CgroupVersion'] == '2'
        assert 'name=apparmor' in info['SecurityOptions']
        report['dockerVersion'] = info['ServerVersion']
        report['kernelVersion'] = info['KernelVersion']
        report['stage'] = 'rootfs-import'
        # No registry access or production image approval needed for this probe.
        contents = Path('/bin/busybox').read_bytes()
        report['busyboxSha256'] = sha256(contents).hexdigest()
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w') as archive:
            item = tarfile.TarInfo('bin/busybox')
            item.size, item.mode = len(contents), 0o755
            archive.addfile(item, io.BytesIO(contents))
        image = docker('import', '-', data=buffer.getvalue())
        assert image.startswith('sha256:')
        report['imageId'] = image
        (root / 'attachment').write_text('synthetic attachment\n')
        flags = [
            '--pull=never', '--init', '--network=none', '--ipc=private', '--cgroupns=private',
            '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges=true',
            '--security-opt=apparmor=docker-default', '--cpus=2', '--memory=4g',
            '--memory-swap=4g', '--pids-limit=128', '--ulimit=core=0',
            '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=512m,mode=1777', '--user=1000:1000',
            '--mount', f'type=bind,source={root},target={root}',
            '--mount', f'type=bind,source={root}/attachment,target=/attachment,readonly',
            '--entrypoint=/bin/busybox',
        ]
        probe = r'''
set -eu
bb=/bin/busybox
test "$($bb id -u)" = 1000
test "$($bb cat /proc/self/attr/current)" = 'docker-default (enforce)'
$bb grep -q '^NoNewPrivs:[[:space:]]*1$' /proc/self/status
$bb grep -q '^Seccomp:[[:space:]]*2$' /proc/self/status
$bb grep -q '^CapEff:[[:space:]]*0000000000000000$' /proc/self/status
test "$($bb cat /sys/fs/cgroup/memory.max)" = 4294967296
test "$($bb cat /sys/fs/cgroup/pids.max)" = 128
test "$($bb cat /sys/fs/cgroup/cpu.max)" = '200000 100000'
test "$($bb cat /attachment)" = 'synthetic attachment'
if (echo forbidden >/attachment) 2>/dev/null; then exit 1; fi
if (echo forbidden >/forbidden) 2>/dev/null; then exit 1; fi
test ! -e /var/run/docker.sock
# The none network has only loopback, including no IPv6 non-loopback route.
test "$($bb ls /sys/class/net)" = lo
echo ready
'''
        report['stage'] = 'restricted-runtime'
        identity = docker('create', *flags, image, 'sh', '-c', probe)
        containers.append(identity)
        assert docker('start', '--attach', identity) == 'ready'
        assert docker('inspect', '--format', '{{.State.ExitCode}}', identity) == '0'
        details = json.loads(docker('inspect', '--format', '{{json .}}', identity))
        assert details['Image'] == image and details['AppArmorProfile'] == 'docker-default'
        assert not details['HostConfig']['Privileged']
        assert details['HostConfig']['ReadonlyRootfs']
        assert details['HostConfig']['NetworkMode'] == 'none'
        checks.update(apparmor=True, seccomp=True, noNewPrivileges=True, capabilities=True,
                      cpuLimit=True, memoryLimit=True, pidLimit=True, readonlyRoot=True,
                      readonlyAttachment=True, isolatedNetwork=True, bindMount=True)
        assert (root / 'attachment').read_text() == 'synthetic attachment\n'
        # Two real writers must both stop when their whole worker is stopped.
        report['stage'] = 'whole-worker-termination'
        script = f'''
bb=/bin/busybox
$bb sh -c 'while :; do echo child >>{root}/child; /bin/busybox sleep .1; done' &
while :; do echo parent >>{root}/parent; $bb sleep .1; done
'''
        identity = docker('create', *flags, image, 'sh', '-c', script)
        containers.append(identity)
        docker('start', identity)
        until = time.monotonic() + 10
        while not all((root / name).exists() and (root / name).stat().st_size for name in ['parent', 'child']):
            if time.monotonic() > until:
                raise RuntimeError('Parent/child writers did not start')
            time.sleep(.1)
        docker('stop', '--time=2', identity)
        assert docker('inspect', '--format', '{{.State.Running}}', identity) == 'false'
        sizes = [(root / name).stat().st_size for name in ['parent', 'child']]
        time.sleep(.3)
        assert sizes == [(root / name).stat().st_size for name in ['parent', 'child']]
        checks['wholeWorkerTermination'] = True
        report['complete'] = True
        report['stage'] = 'complete'
    except Exception as error:
        report['error'] = str(error) or type(error).__name__
    finally:
        try:
            for identity in containers:
                docker('stop', '--time=2', identity)
                assert docker('inspect', '--format', '{{.State.Running}}', identity) == 'false'
                docker('rm', identity)
            if image:
                docker('image', 'rm', image)
        except Exception:
            report['complete'] = False
            report['cleanupError'] = 'Guest smoke resource cleanup failed; outer VM teardown still required'
        Path('/home/cf/smoke.json').write_text(json.dumps(report, indent=2) + '\n')
    return 0 if report['complete'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
