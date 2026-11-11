"""Disposable development tests; never connects to the Ubuntu host Docker Engine."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import tarfile
import tempfile
import threading
import time
from urllib.request import build_opener, HTTPRedirectHandler, ProxyHandler

from cloud_init import configuration

ROOT = Path(__file__).resolve().parents[2]
TOOLS = Path(__file__).resolve().parent
MAX_DOWNLOAD = 1024 * 1024 * 1024
MAX_SNAPSHOT = 1024 * 1024 * 1024
MAX_OUTPUT = 2 * 1024 * 1024


def copy_bounded(source, target, limit=MAX_OUTPUT):
    """Drain output after the log limit so a noisy guest cannot fill host disk."""
    remaining = limit
    while chunk := source.read(65536):
        target.write(chunk[:remaining])
        remaining = max(0, remaining - len(chunk))
    target.flush()


def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def private_directory(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or path.resolve() != path.absolute() or path.stat().st_uid != os.getuid():
        raise RuntimeError('Expected a private, canonical directory owned by this user')
    path.chmod(0o700)
    return path


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise RuntimeError('Artifact redirects are not allowed')


def download(artifact, directory):
    """Cache by checksum. A replaced/mutable upstream artifact fails closed."""
    path = directory / artifact['sha256']
    if path.exists():
        if path.is_symlink() or not path.is_file() or digest(path) != artifact['sha256']:
            raise RuntimeError('Cached artifact checksum mismatch')
        return path
    descriptor, temporary_name = tempfile.mkstemp(prefix=artifact['sha256'] + '-', suffix='.partial', dir=directory)
    temporary = Path(temporary_name)
    opener = build_opener(ProxyHandler({}), NoRedirect())
    started = time.monotonic()
    try:
        with os.fdopen(descriptor, 'wb') as target, opener.open(artifact['url'], timeout=30) as response:
            total = 0
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_DOWNLOAD or time.monotonic() - started > 600:
                    raise RuntimeError('Artifact download exceeded its budget')
                target.write(chunk)
        if digest(temporary) != artifact['sha256']:
            raise RuntimeError('Downloaded artifact checksum mismatch')
        temporary.chmod(0o400)
        temporary.rename(path)
        return path
    finally:
        temporary.unlink(missing_ok=True)


def snapshot(repository, destination):
    """Explicit source/dependency inputs, no .git, homes, state or scratch exports."""
    candidates = [repository / 'package.json', repository / 'yarn.lock']
    for directory, suffixes in [('src', {'.ts'}), ('runtime/environment', {'.py', '.Dockerfile'}),
                                ('test', {'.ts'})]:
        candidates.extend(p for p in (repository / directory).rglob('*') if p.suffix in suffixes)
    candidates.extend((repository / 'node_modules').rglob('*'))
    total = 0
    with tarfile.open(destination, 'w:gz', dereference=True) as archive:
        for path in sorted(candidates):
            relative = path.relative_to(repository)
            if any(part.startswith('.') for part in relative.parts):
                continue
            if path.is_dir():
                continue
            resolved = path.resolve()
            if not resolved.is_relative_to(repository.resolve()) or not path.is_file():
                raise RuntimeError('Snapshot input escapes repository or is not a regular file')
            if path.is_symlink() and relative.parts[0] != 'node_modules':
                raise RuntimeError('Symlinked source input refused')
            # Credential/state files are never needed as dependency inputs.
            if path.suffix in {'.db', '.sqlite', '.sqlite3', '.pem', '.key'}:
                continue
            total += path.stat().st_size
            if total > MAX_SNAPSHOT:
                raise RuntimeError('Source/dependency snapshot exceeds 1 GiB')
            archive.add(path, arcname=str(relative), recursive=False)


def qemu_arguments(run, base, port, seconds, images=None):
    # No KVM, devices, host filesystem shares, monitor, Docker socket or TAP.
    # guestfwd spawns only the fixed package helper; it cannot select a command.
    forward = f'timeout --foreground --signal=KILL 60s python3 {TOOLS}/apt_proxy.py {run}/bootstrap-enabled'
    args = [
        'timeout', '--signal=TERM', '--kill-after=10s', f'{seconds}s',
        'qemu-system-x86_64', '-no-user-config', '-nodefaults',
        '-machine', 'q35,dump-guest-core=off', '-accel', 'tcg,thread=single,tb-size=64', '-cpu', 'max,la57=off',
        '-smp', '2', '-m', '3072', '-display', 'none', '-monitor', 'none',
        '-serial', 'stdio', '-no-reboot',
        '-drive', f'file={run}/disk.qcow2,format=qcow2,if=none,id=guest-root',
        '-device', 'virtio-blk-pci,drive=guest-root,bootindex=1',
        '-drive', f'file={run}/seed.img,format=raw,if=virtio,readonly=on',
        '-netdev', f'user,id=net,restrict=on,ipv6=off,hostfwd=tcp:127.0.0.1:{port}-:22,guestfwd=tcp:10.0.2.100:3128-cmd:{forward}',
        '-device', 'virtio-net-pci,netdev=net',
    ]
    if images is not None:
        args.extend([
            '-blockdev', json.dumps({'driver': 'raw', 'node-name': 'reviewed-images',
                                    'read-only': True, 'file': {'driver': 'file', 'filename': str(images)}}),
            '-device', 'virtio-blk-pci,drive=reviewed-images,serial=cf-reviewed-images',
        ])
    return args


def stop_vm(process):
    if process is None:
        return
    # The group belongs to this Popen instance, never a recorded/stale PID.
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=5)
    # timeout and QEMU share this group. Refuse disk deletion if any survives.
    try:
        os.killpg(process.pid, 0)
    except ProcessLookupError:
        return
    raise RuntimeError('VM process group termination could not be verified; disk retained')


class Guest:
    def __init__(self, directory, port, deadline):
        self.directory = directory
        self.deadline = deadline
        self.env = {'PATH': os.environ.get('PATH', os.defpath), 'HOME': str(directory), 'LC_ALL': 'C'}
        self.ssh = [
            'ssh', '-F', '/dev/null', '-p', str(port), '-i', str(directory / 'key'),
            '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
            '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
            '-o', 'StrictHostKeyChecking=yes', '-o', f'UserKnownHostsFile={directory}/known_hosts',
            '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=3',
            '-o', 'KexAlgorithms=curve25519-sha256', '-o', 'PreferredAuthentications=publickey',
            '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', 'cf@127.0.0.1',
        ]

    def execute(self, args, *, seconds=60, input_file=None, output_file=None, check=True):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError('Integration deadline exceeded')
        # Only the local SSH process gets a file-size limit; never limit the VM's
        # block writes. A guest cannot fill host disk/memory through report stdout.
        launched = ['prlimit', f'--fsize={MAX_OUTPUT}:{MAX_OUTPUT}', '--', *args] if args[0] == 'ssh' else args
        with tempfile.TemporaryFile(dir=self.directory) as capture, (self.directory / 'last-operation.stderr').open('wb') as diagnostic:
            try:
                result = subprocess.run(
                    launched, stdin=input_file, stdout=output_file or capture,
                    stderr=diagnostic, env=self.env, timeout=min(seconds, remaining),
                )
            except subprocess.TimeoutExpired:
                if check:
                    raise RuntimeError('Integration operation exceeded its deadline') from None
                return subprocess.CompletedProcess(args, 124)
            if output_file is None:
                capture.seek(0)
                result.stdout = capture.read(MAX_OUTPUT + 1)
                if len(result.stdout) > MAX_OUTPUT:
                    raise RuntimeError('Integration output exceeded 2 MiB')
        if check and result.returncode:
            raise RuntimeError(f'Integration operation failed (exit {result.returncode}); inspect private last-operation.stderr and guest reports/console')
        return result

    def command(self, command, **kwargs):
        return self.execute([*self.ssh, command], **kwargs)

    def upload(self, path, remote, seconds=120):
        # remote is an internal constant; no user-controlled shell interpolation.
        with path.open('rb') as source:
            self.command(f'cat > {remote}', input_file=source, seconds=seconds)


def run(args):
    if os.getuid() == 0:
        raise RuntimeError('Run integration as the non-root development user')
    for tool in ['qemu-system-x86_64', 'qemu-img', 'cloud-localds', 'ssh', 'ssh-keygen', 'timeout', 'prlimit']:
        if not shutil.which(tool):
            raise RuntimeError(f'Missing {tool}; rebuild the Code Foundry devcontainer to install VM tools')
    if any(c.isspace() or c in ',:' for c in str(ROOT)):
        raise RuntimeError('Integration requires a repository path without whitespace, commas or colons')
    images = None
    if not args.smoke:
        if not args.images:
            raise RuntimeError('Full integration needs --images /absolute/reviewed-images.tar (Docker save archive of the existing approved worker/database IDs). Smoke needs no archive.')
        images = Path(args.images)
        if not images.is_absolute() or images.is_symlink() or not images.is_file():
            raise RuntimeError('Expected an explicit absolute regular reviewed-image archive')
        if images.stat().st_size > 8 * 1024 * 1024 * 1024:
            raise RuntimeError('Reviewed image archive exceeds the 8 GiB input budget')
    private_directory(ROOT / 'scratch')
    cache = private_directory(ROOT / 'scratch/integration-cache')
    directory = Path(tempfile.mkdtemp(prefix='integration-', dir=ROOT / 'scratch'))
    print(f'Integration reports: {directory}', flush=True)
    started = time.monotonic()
    report = {'complete': False, 'mode': 'smoke' if args.smoke else 'environment',
              'startedAt': datetime.now(timezone.utc).isoformat(),
              'scope': 'Disposable guest evidence, not Ubuntu host or Vela acceptance',
              'vmStopped': False, 'diskRemoved': False}
    process = None
    guest = None
    log_thread = None
    log = None
    def checkpoint(stage):
        report['stage'] = stage
        report['elapsedSeconds'] = round(time.monotonic() - started, 2)
        (directory / 'report.json').write_text(json.dumps(report, indent=2) + '\n')

    try:
        checkpoint('artifacts')
        artifacts = json.loads((TOOLS / 'artifacts.json').read_text())
        print('Verifying/downloading the pinned Ubuntu cloud image', flush=True)
        base = download(artifacts['ubuntu'], cache)
        report['ubuntuSha256'] = artifacts['ubuntu']['sha256']
        deadline = time.monotonic() + args.timeout
        # Reserve an ephemeral loopback port. QEMU fails closed if it is taken.
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            port = reservation.getsockname()[1]
        guest = Guest(directory, port, deadline)
        report['qemuVersion'] = guest.execute(['qemu-system-x86_64', '--version']).stdout.decode().splitlines()[0]
        for key in ['key', 'host-key']:
            guest.execute(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(directory / key)])
        user_data = json.loads(configuration((directory / 'key.pub').read_text()).split('\n', 1)[1])
        user_data['ssh_keys'] = {
            'ed25519_private': (directory / 'host-key').read_text(),
            'ed25519_public': (directory / 'host-key.pub').read_text().strip(),
        }
        (directory / 'user-data').write_text('#cloud-config\n' + json.dumps(user_data))
        (directory / 'meta-data').write_text(json.dumps({'instance-id': directory.name, 'local-hostname': 'cf-disposable'}))
        (directory / 'known_hosts').write_text(f'[127.0.0.1]:{port} ' + (directory / 'host-key.pub').read_text())
        guest.execute(['cloud-localds', str(directory / 'seed.img'), str(directory / 'user-data'), str(directory / 'meta-data')])
        guest.execute(['qemu-img', 'create', '-q', '-f', 'qcow2', '-F', 'qcow2', '-b', str(base), str(directory / 'disk.qcow2'), '24G'])
        (directory / 'bootstrap-enabled').touch(mode=0o600)
        log = (directory / 'qemu.log').open('wb')
        process = subprocess.Popen(qemu_arguments(directory, base, port, args.timeout, images),
                                   env=guest.env, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
        # Diagnostic identity only. Never kill a process using a stale file.
        identity = {'pid': process.pid, 'group': os.getpgid(process.pid),
                    'startTicks': Path(f'/proc/{process.pid}/stat').read_text().split()[21],
                    'run': str(directory), 'timeoutSeconds': args.timeout}
        (directory / 'vm-identity.json').write_text(json.dumps(identity, indent=2) + '\n')
        report['vmIdentity'] = identity
        log_thread = threading.Thread(target=copy_bounded, args=(process.stdout, log), daemon=True)
        log_thread.start()
        boot_deadline = min(deadline, time.monotonic() + 300)
        print('Booting isolated Ubuntu guest using software emulation', flush=True)
        checkpoint('boot')
        while True:
            if process.poll() is not None:
                raise RuntimeError('QEMU exited before guest readiness; inspect qemu.log')
            if time.monotonic() > boot_deadline:
                raise RuntimeError('Guest SSH boot exceeded 300 seconds')
            if guest.command('true', seconds=15, check=False).returncode == 0:
                break
            time.sleep(1)
        print('Waiting for bounded Ubuntu package bootstrap', flush=True)
        checkpoint('bootstrap')
        guest.command('sudo timeout --kill-after=5s 600s cloud-init status --wait', seconds=610)
        (directory / 'bootstrap-enabled').unlink()
        guest.command("test \"$(cat /etc/code-foundry-disposable)\" = code-foundry-disposable-v1 && sudo rm -f /etc/apt/apt.conf.d/90cloud-init-aptproxy")
        report['bootstrapSeconds'] = round(time.monotonic() - started, 2)
        guest.upload(TOOLS / 'smoke.py', '/home/cf/smoke.py')
        print('Checking actual Docker/AppArmor/seccomp/cgroup/mount/termination behavior', flush=True)
        checkpoint('smoke')
        guest.command('timeout --kill-after=5s 180s python3 /home/cf/smoke.py', seconds=190)
        with (directory / 'smoke.json').open('wb') as output:
            guest.command('cat /home/cf/smoke.json', output_file=output)
        smoke = json.loads((directory / 'smoke.json').read_text())
        if smoke.get('complete') is not True:
            raise RuntimeError('Guest smoke did not report success')
        report['smoke'] = smoke
        if images is not None:
            print('Loading the read-only approved image disk and transferring allowlisted test inputs', flush=True)
            node = download(artifacts['node'], cache)
            guest.upload(node, '/home/cf/node.tar.xz')
            guest.command('sudo mkdir /opt/node && sudo tar -xJf /home/cf/node.tar.xz --strip-components=1 -C /opt/node && rm /home/cf/node.tar.xz', seconds=120)
            report['imagesArchiveSha256'] = digest(images)
            checkpoint('image-load')
            guest.command("sudo sh -c 'docker load --quiet < /dev/disk/by-id/virtio-cf-reviewed-images'", seconds=600)
            payload = directory / 'source.tar.gz'
            checkpoint('source-transfer')
            snapshot(ROOT, payload)
            report['sourceSha256'] = digest(payload)
            with payload.open('rb') as source:
                guest.command('mkdir /home/cf/code-foundry && tar xzf - -C /home/cf/code-foundry', input_file=source, seconds=180)
            payload.unlink()
            print('Preparing two real restricted synthetic environments', flush=True)
            checkpoint('environment')
            guest.command('cd /home/cf/code-foundry && PATH=/opt/node/bin:/usr/bin:/bin timeout --kill-after=5s 900s node --import tsx test/integration/environment.ts', seconds=910)
            with (directory / 'environment.json').open('wb') as output:
                guest.command('cat /home/cf/environment-report.json', output_file=output)
            environment = json.loads((directory / 'environment.json').read_text())
            if environment.get('complete') is not True:
                raise RuntimeError('Environment integration did not report success')
            report['environment'] = environment
        report['complete'] = True
    except (Exception, KeyboardInterrupt) as error:
        report['error'] = str(error)
        diagnostic = directory / 'last-operation.stderr'
        if diagnostic.exists():
            shutil.copyfile(diagnostic, directory / 'failure.stderr')
        if guest is not None and process is not None and process.poll() is None:
            # Best effort, only known JSON reports; never credentials, sockets or DB dumps.
            try:
                for local, remote in [('environment.json', 'environment-report.json'), ('smoke.json', 'smoke.json')]:
                    if (directory / local).exists() and (directory / local).stat().st_size:
                        continue
                    with (directory / local).open('wb') as output:
                        guest.command(f'cat /home/cf/{remote}', seconds=5, output_file=output, check=False)
            except (Exception, KeyboardInterrupt):
                pass
    finally:
        (directory / 'bootstrap-enabled').unlink(missing_ok=True)
        try:
            stop_vm(process)
            report['vmStopped'] = True
            if not args.keep_artifacts:
                (directory / 'disk.qcow2').unlink(missing_ok=True)
                report['diskRemoved'] = True
        except Exception as error:
            report['complete'] = False
            report['cleanupError'] = str(error)
        if log_thread is not None:
            log_thread.join(timeout=2)
        if log is not None and (log_thread is None or not log_thread.is_alive()):
            log.close()
        if process is not None and process.stdout is not None and (log_thread is None or not log_thread.is_alive()):
            process.stdout.close()
        # Remove ephemeral keys/seed and source payload, including on failure.
        for name in ['key', 'key.pub', 'host-key', 'host-key.pub', 'known_hosts',
                     'user-data', 'meta-data', 'seed.img', 'source.tar.gz']:
            (directory / name).unlink(missing_ok=True)
        report['elapsedSeconds'] = round(time.monotonic() - started, 2)
        (directory / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    if not report['complete']:
        raise RuntimeError(f'Integration failed: {report.get("error", report.get("cleanupError"))}. Report: {directory}/report.json')
    print(f'Integration passed in {report["elapsedSeconds"]}s; VM stopped; report: {directory}/report.json', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--smoke', action='store_true', help='No approved image archive or real model needed')
    parser.add_argument('--images', default=os.environ.get('CF_INTEGRATION_IMAGES'), help='Absolute Docker save archive containing both existing approved image IDs')
    parser.add_argument('--keep-artifacts', action='store_true', help='Keep stopped disposable guest disk for diagnosis')
    parser.add_argument('--timeout', type=int, default=1800, help='Guest lifetime in seconds (60..3600), independently enforced by timeout')
    args = parser.parse_args()
    if not 60 <= args.timeout <= 3600:
        parser.error('--timeout must be between 60 and 3600 seconds')
    os.umask(0o077)
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    try:
        run(args)
    except (Exception, KeyboardInterrupt) as error:
        print(str(error), flush=True)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
