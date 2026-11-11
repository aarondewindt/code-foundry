"""Safety regressions runnable without Docker, a VM, root or external networking."""
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import apt_proxy
from cloud_init import configuration
import vm


class VmTests(unittest.TestCase):
    def test_noisy_guest_log_is_drained_but_storage_is_bounded(self):
        source, target = io.BytesIO(b'x' * 32), io.BytesIO()
        vm.copy_bounded(source, target, limit=8)
        self.assertEqual(target.getvalue(), b'x' * 8)
        self.assertEqual(source.tell(), 32)

    def test_launch_has_no_host_authority_and_an_independent_deadline(self):
        args = vm.qemu_arguments(Path('/private/run'), Path('/private/base'), 12345, 90)
        command = ' '.join(args)
        self.assertEqual(args[:4], ['timeout', '--signal=TERM', '--kill-after=10s', '90s'])
        self.assertIn('q35,dump-guest-core=off', args)
        self.assertIn('tcg,thread=single,tb-size=64', args)
        self.assertEqual(args[args.index('-m') + 1], '3072')
        self.assertEqual(args[args.index('-smp') + 1], '2')
        self.assertEqual(args[args.index('-cpu') + 1], 'max,la57=off')
        self.assertIn('virtio-blk-pci,drive=guest-root,bootindex=1', args)
        self.assertIn('restrict=on,ipv6=off,hostfwd=tcp:127.0.0.1:12345-:22', command)
        for forbidden in ['docker.sock', '/dev/kvm', 'virtfs', 'virtiofs', 'smb=', 'tap,', 'accel=kvm']:
            self.assertNotIn(forbidden, command)
        self.assertIn('/private/run/bootstrap-enabled', command)
        self.assertNotIn('SSH_AUTH_SOCK', command)

    def test_cleanup_stops_only_the_owned_process_group(self):
        process = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], start_new_session=True)
        try:
            vm.stop_vm(process)
            self.assertIsNotNone(process.poll())
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()

    def test_reviewed_archive_is_an_explicit_readonly_virtual_disk(self):
        images = Path('/private/reviewed,images.tar')
        args = vm.qemu_arguments(Path('/private/run'), Path('/private/base'), 12345, 90, images)
        block = json.loads(args[args.index('-blockdev') + 1])
        self.assertTrue(block['read-only'])
        self.assertEqual(block['driver'], 'raw')
        self.assertEqual(block['file'], {'driver': 'file', 'filename': str(images)})
        self.assertIn('virtio-blk-pci,drive=reviewed-images,serial=cf-reviewed-images', args)

    def test_cleanup_refuses_to_claim_success_if_group_survives(self):
        process = unittest.mock.Mock(pid=123)
        process.wait.return_value = 0
        with patch('vm.os.killpg') as kill:
            with self.assertRaisesRegex(RuntimeError, 'disk retained'):
                vm.stop_vm(process)
            self.assertEqual(kill.call_count, 2)

    def test_ssh_never_uses_developer_config_agent_or_credentials(self):
        guest = vm.Guest(Path('/private/run'), 12345, 999999999)
        self.assertIn('IdentityAgent=none', guest.ssh)
        self.assertIn('ForwardAgent=no', guest.ssh)
        self.assertIn('StrictHostKeyChecking=yes', guest.ssh)
        self.assertEqual(set(guest.env), {'PATH', 'HOME', 'LC_ALL'})
        self.assertIn('/dev/null', guest.ssh)

    def test_guest_stdout_cannot_exceed_the_local_file_size_budget(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            executable = root / 'ssh'
            executable.write_text('#!/usr/bin/python3\nimport os\nfor _ in range(3): os.write(1,b"x"*1048576)\n')
            executable.chmod(0o700)
            guest = vm.Guest(root, 12345, 999999999)
            guest.env['PATH'] = str(root) + os.pathsep + os.defpath
            with self.assertRaisesRegex(RuntimeError, 'Integration operation failed'):
                guest.execute(['ssh'])
            self.assertEqual(set(root.iterdir()), {executable, root / 'last-operation.stderr'})

    def test_failed_guest_command_retains_private_stderr(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            guest = vm.Guest(root, 12345, 999999999)
            with self.assertRaisesRegex(RuntimeError, 'exit 7'):
                guest.execute([sys.executable, '-c', 'import sys; print("synthetic failure",file=sys.stderr); sys.exit(7)'])
            self.assertEqual((root / 'last-operation.stderr').read_text(), 'synthetic failure\n')

    def test_snapshot_excludes_state_and_external_symlinks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ['src', 'runtime/environment', 'test', 'node_modules', 'scratch', '.git']:
                (root / name).mkdir(parents=True)
            for name in ['package.json', 'yarn.lock', 'src/main.ts', 'test/fixture.ts',
                         'runtime/environment/worker.py', 'node_modules/index.js',
                         'node_modules/.env', 'node_modules/private.key', '.git/config',
                         'scratch/credentials.ts', 'src/state.sqlite']:
                (root / name).write_text('synthetic')
            payload = root / 'payload.tgz'
            vm.snapshot(root, payload)
            with tarfile.open(payload) as archive:
                self.assertEqual(set(archive.getnames()), {
                    'package.json', 'yarn.lock', 'src/main.ts', 'test/fixture.ts',
                    'runtime/environment/worker.py', 'node_modules/index.js',
                })
            (root / 'node_modules/escape.js').symlink_to('/etc/passwd')
            with self.assertRaisesRegex(RuntimeError, 'escapes repository'):
                vm.snapshot(root, payload)

    def test_cached_image_tampering_is_not_a_cache_hit(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifact = {'sha256': 'a' * 64, 'url': 'https://example.invalid/image'}
            (root / artifact['sha256']).write_bytes(b'tampered')
            with self.assertRaisesRegex(RuntimeError, 'checksum mismatch'):
                vm.download(artifact, root)

    def test_failed_download_does_not_publish_or_leave_partial_artifacts(self):
        with tempfile.TemporaryDirectory() as temporary, patch('vm.build_opener') as opener:
            root = Path(temporary)
            opener.return_value.open.return_value.__enter__.return_value = io.BytesIO(b'wrong image')
            artifact = {'sha256': 'a' * 64, 'url': 'https://example.invalid/image'}
            with self.assertRaisesRegex(RuntimeError, 'checksum mismatch'):
                vm.download(artifact, root)
            self.assertEqual(list(root.iterdir()), [])

    def test_failed_setup_writes_failure_and_cleanup_evidence(self):
        with tempfile.TemporaryDirectory() as temporary, patch('vm.ROOT', Path(temporary)), \
                patch('vm.shutil.which', return_value='/usr/bin/tool'), \
                patch('vm.download', side_effect=RuntimeError('synthetic setup failure')):
            args = SimpleNamespace(smoke=True, images=None, timeout=60, keep_artifacts=False)
            with self.assertRaisesRegex(RuntimeError, 'synthetic setup failure'):
                vm.run(args)
            report_path, = (Path(temporary) / 'scratch').glob('integration-*/report.json')
            report = json.loads(report_path.read_text())
            self.assertFalse(report['complete'])
            self.assertTrue(report['vmStopped'])
            self.assertTrue(report['diskRemoved'])

    def test_cloud_init_installs_guest_services_without_credentials_or_model(self):
        config = json.loads(configuration('ssh-ed25519 synthetic').split('\n', 1)[1])
        self.assertEqual(config['users'][0]['ssh_authorized_keys'], ['ssh-ed25519 synthetic'])
        self.assertEqual(config['users'][0]['uid'], 1000)
        self.assertFalse(config['ssh_pwauth'])
        self.assertEqual(config['apt']['proxy'], 'http://10.0.2.100:3128')
        self.assertIn('docker.io', config['packages'])
        self.assertIn('libatomic1', config['packages'])
        self.assertNotIn('ollama', json.dumps(config))


class PackageProxyTests(unittest.TestCase):
    def test_only_fixed_ubuntu_http_package_destinations_are_allowed(self):
        self.assertEqual(apt_proxy.destination('http://archive.ubuntu.com/ubuntu/dists/noble/InRelease'),
                         ('archive.ubuntu.com', '/ubuntu/dists/noble/InRelease'))
        for url in ['http://127.0.0.1/ubuntu/test', 'http://host.docker.internal/ubuntu/test',
                    'http://archive.ubuntu.com:2375/ubuntu/test', 'http://user@archive.ubuntu.com/ubuntu/test',
                    'https://archive.ubuntu.com/ubuntu/test', 'http://archive.ubuntu.com/private',
                    'http://archive.ubuntu.com/ubuntu/test?url=http://elsewhere',
                    'http://archive.ubuntu.com/ubuntu/test\r\nHost: localhost']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                apt_proxy.destination(url)

    def test_dns_cannot_redirect_a_permitted_hostname_to_private_resources(self):
        for address in ['127.0.0.1', '172.17.0.1', '192.168.1.1', '169.254.169.254', '::1']:
            with patch('apt_proxy.socket.getaddrinfo', return_value=[(2, 1, 6, '', (address, 80))]):
                with self.assertRaises(ValueError):
                    apt_proxy.public_address('archive.ubuntu.com')

    def test_disabled_bootstrap_denies_even_permitted_requests_without_network(self):
        with tempfile.TemporaryDirectory() as temporary, patch('apt_proxy.public_address') as resolve:
            source = io.BytesIO(b'GET http://archive.ubuntu.com/ubuntu/test HTTP/1.1\r\n\r\n')
            target = io.BytesIO()
            apt_proxy.serve(source, target, Path(temporary) / 'absent')
            self.assertIn(b'403 Denied', target.getvalue())
            resolve.assert_not_called()

    def test_connect_credentials_and_unbounded_headers_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary, patch('apt_proxy.public_address') as resolve:
            enabled = Path(temporary) / 'enabled'
            enabled.touch()
            for request in [b'CONNECT archive.ubuntu.com:443 HTTP/1.1\r\n\r\n',
                            b'GET http://archive.ubuntu.com/ubuntu/test HTTP/1.1\r\nAuthorization: secret\r\n\r\n',
                            b'GET http://archive.ubuntu.com/ubuntu/test HTTP/1.1\r\n' + b'x' * 8193]:
                target = io.BytesIO()
                apt_proxy.serve(io.BytesIO(request), target, enabled)
                self.assertIn(b'403 Denied', target.getvalue())
            resolve.assert_not_called()


if __name__ == '__main__':
    unittest.main()
