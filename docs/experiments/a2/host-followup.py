"""Host-only synthetic worktree, termination and PostgreSQL 18 follow-up for A2.

No agent/model execution, published ports, Docker socket mounts or existing DBs.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time


def command(args, *, env=None, timeout=30, check=True):
    result = subprocess.run([str(arg) for arg in args], env=env, capture_output=True,
                            text=True, timeout=timeout)
    if check and result.returncode:
        # All commands target synthetic fixtures; retain output locally for diagnosis.
        raise RuntimeError(f'{args[0]} exited {result.returncode}: {result.stderr[-4000:]}')
    return result


def git(*args):
    env = {'PATH': os.environ['PATH'], 'GIT_CONFIG_NOSYSTEM': '1',
           'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0'}
    return command(['git', '-c', 'core.hooksPath=/dev/null', '-c',
                    'commit.gpgsign=false', *args], env=env).stdout.strip()


def prepare_worktree(root):
    source = root / 'source'
    task = root / 'task'
    task.mkdir()
    git('init', '--initial-branch=main', source)
    (source / 'fixture.txt').write_text('synthetic source\n')
    git('-C', source, 'add', 'fixture.txt')
    # Only this new disposable fixture receives a seed commit.
    git('-C', source, '-c', 'user.name=A2 Fixture', '-c',
        'user.email=fixture@example.invalid', 'commit', '-m', 'Synthetic host fixture')
    base = git('-C', source, 'rev-parse', 'HEAD')
    git('clone', '--bare', '--no-hardlinks', source, task / 'store.git')
    git('--git-dir', task / 'store.git', 'worktree', 'add', '-b', 'a2-host-task',
        task / 'worktree', base)
    return source, task, base


def host_runtime(container):
    # Never export a full inspect/environment dump.
    template = ('{"id":{{json .Id}},"running":{{.State.Running}},"status":{{json .State.Status}},'
                '"exitCode":{{.State.ExitCode}},"pidMode":{{json .HostConfig.PidMode}},'
                '"ipcMode":{{json .HostConfig.IpcMode}},'
                '"apparmorProfile":{{json .AppArmorProfile}},'
                '"network":{{json .HostConfig.NetworkMode}},'
                '"privileged":{{.HostConfig.Privileged}},'
                '"mounts":{{json .Mounts}}}')
    value = json.loads(command(['docker', 'inspect', '--format', template, container]).stdout)
    # Keep mount identities/types/modes only. Source paths are this run's fixtures.
    value['mounts'] = [{key: mount.get(key) for key in ['Type', 'Name', 'Source', 'Destination', 'RW']}
                       for mount in value['mounts']]
    return value


def restricted(container, root):
    return ['docker', 'run', '--name', container, '--pull=never', '--init',
            '--label', f'code-foundry.synthetic-followup={root.name}',
            '--network', 'none', '--ipc', 'private', '--read-only', '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges=true', '--cpus', '2', '--memory', '4g',
            '--memory-swap', '4g', '--pids-limit', '128', '--ulimit', 'core=0',
            '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=512m,mode=1777']


def run_container(args, *, timeout=30, check=True):
    # Obtain immutable ownership before starting; a timed-out Docker client alone
    # would otherwise leave its container running.
    create = list(args)
    create[1] = 'create'
    container_id = command(create).stdout.strip()
    if not re.fullmatch(r'[0-9a-f]{64}', container_id):
        raise RuntimeError('Expected immutable Docker container ID')
    try:
        return command(['docker', 'start', '--attach', container_id], timeout=timeout, check=check)
    finally:
        runtime = host_runtime(container_id)
        if runtime['running']:
            command(['docker', 'stop', '--time', '2', container_id], timeout=10)


def wait_for(predicate, seconds=10):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        if predicate():
            return
        time.sleep(0.1)
    raise RuntimeError('Synthetic container readiness timed out')


def run_followup(repo, export):
    if os.getuid() == 0:
        raise RuntimeError('Run as the non-root Ubuntu developer with existing Docker access')
    if command(['docker', 'info', '--format', '{{.OSType}}']).stdout.strip() != 'linux':
        raise RuntimeError('A Linux Docker engine is required')
    image = (export / 'image-id').read_text().strip()
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', image):
        raise RuntimeError('Expected immutable local image ID from the offline probe')
    previous = json.loads((export / 'result.json').read_text())
    if previous.get('pass') is not True:
        raise RuntimeError('Prior offline probe must pass before the follow-up')
    command(['docker', 'image', 'inspect', '--format', '{{.Id}}', image])
    root = Path(tempfile.mkdtemp(prefix='code-foundry-a2-followup-')).resolve()
    print(f'Evidence directory: {root}', flush=True)
    report = {'scope': 'Synthetic worktree/process/database follow-up only; no Vela access or agent execution',
              'imageId': image, 'complete': False, 'containers': [],
              'notVerified': ['Service-enabled worker gateways and direct-bypass denial',
                              'OpenCode in the service-enabled restricted profile',
                              'Real client migration tooling', 'Manual VS Code editing',
                              'Separate supervised side-effect path']}
    (root / 'probe-sha256.json').write_text(json.dumps({str(path.relative_to(repo)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in [Path(__file__).resolve(), repo / 'docs/experiments/a2/database-probe.py',
                     repo / 'docs/experiments/a2/pgvector-probe.Dockerfile',
                     repo / 'docs/experiments/a2/process-writers.py']}, indent=2) + '\n')
    active = None
    try:
        source, task, base = prepare_worktree(root)
        tree = task / 'worktree'
        path_check = (
            "import pathlib,subprocess,json,sys; "
            "tree=pathlib.Path(sys.argv[1]); task=tree.parent; "
            "run=lambda *a: subprocess.check_output(['git','-c','safe.directory='+str(tree),'-C',str(tree),*a],text=True).strip(); "
            "common=pathlib.Path(run('rev-parse','--path-format=absolute','--git-common-dir')).resolve(); "
            "assert common.is_relative_to(task); "
            "assert run('rev-parse','HEAD')==sys.argv[2]; "
            "(tree/'fixture.txt').write_text('synthetic task change\\n'); "
            "assert '+synthetic task change' in run('diff','--','fixture.txt'); "
            "print(json.dumps({'commonMetadataInsideTask':True,'baseVerified':True,'taskEditVisible':True}))"
        )
        path_container = f'cf-a2-path-{root.name}'
        report['containers'].append(path_container)
        checked = run_container([*restricted(path_container, root), '--user', f'{os.getuid()}:{os.getgid()}',
                           '--mount', f'type=bind,source={task},target={task}', '--workdir', tree,
                           image, 'python3', '-c', path_check, tree, base])
        result = json.loads(checked.stdout)
        result.update({'hostSeesTaskDiff': '+synthetic task change' in git('-C', tree, 'diff', '--', 'fixture.txt'),
                       'sourceUnchanged': git('-C', source, 'status', '--porcelain') == '' and (source / 'fixture.txt').read_text() == 'synthetic source\n',
                       'base': base, 'worktree': str(tree), 'vscodeOpeningVerified': False})
        if not result['hostSeesTaskDiff'] or not result['sourceUnchanged']:
            raise RuntimeError('Host/container worktree invariants failed')
        result['runtime'] = host_runtime(path_container)
        report['worktree'] = result
        # Two writing processes must both stop when their private container stops.
        process_container = f'cf-a2-process-{root.name}'
        report['containers'].append(process_container)
        launched = command([*restricted(process_container, root), '--detach', '--user', f'{os.getuid()}:{os.getgid()}',
                 '--mount', f'type=bind,source={task},target={task}',
                 '--mount', f'type=bind,source={repo}/docs/experiments/a2/process-writers.py,target=/writers.py,readonly',
                 '--workdir', tree, image, 'python3', '/writers.py', task])
        active = launched.stdout.strip()
        if not re.fullmatch(r'[0-9a-f]{64}', active):
            raise RuntimeError('Expected immutable Docker container ID')
        paths = [task / 'parent-heartbeat', task / 'child-heartbeat']
        wait_for(lambda: all(path.exists() and path.stat().st_size > 0 for path in paths))
        before = [path.read_bytes() for path in paths]
        wait_for(lambda: all(path.read_bytes() != old for path, old in zip(paths, before)))
        command(['docker', 'stop', '--time', '2', active], timeout=10)
        stopped = host_runtime(process_container)
        active = None
        if stopped['running'] or stopped['status'] != 'exited' or stopped['pidMode'] not in ['', 'private'] or stopped['ipcMode'] != 'private':
            raise RuntimeError('Expected stopped container with private process/IPC namespaces')
        final = [path.read_bytes() for path in paths]
        time.sleep(0.5)
        if [path.read_bytes() for path in paths] != final:
            raise RuntimeError('A synthetic writer continued after container stop')
        report['termination'] = {'bothWritersActiveBeforeStop': True, 'containerExited': True,
                                 'bothWritersStopped': True, 'runtime': stopped}
        # A separate, offline image owns the entire disposable SQL cluster.
        pg_image_file = root / 'pg-image-id'
        build = command(['docker', 'build', '--iidfile', pg_image_file, '--file',
                         repo / 'docs/experiments/a2/pgvector-probe.Dockerfile',
                         repo / 'docs/experiments/a2'], timeout=600)
        (root / 'pg-build.log').write_text(build.stdout + build.stderr)
        pg_image = pg_image_file.read_text().strip()
        pg_container = f'cf-a2-pg18-{root.name}'
        report['containers'].append(pg_container)
        pg = run_container([*restricted(pg_container, root), '--user', 'postgres',
                      '--tmpfs', '/var/lib/postgresql:rw,nosuid,nodev,noexec,size=16m,mode=1777',
                      '--mount', f'type=bind,source={repo}/docs/experiments/a2/database-probe.py,target=/probe.py,readonly',
                      pg_image], timeout=180, check=False)
        (root / 'database.json').write_text(pg.stdout)
        (root / 'database.stderr').write_text(pg.stderr)
        if pg.returncode:
            raise RuntimeError(f'PostgreSQL 18 probe failed; retain {root}/database.stderr')
        database = json.loads(pg.stdout)
        if database.get('pass') is not True or database.get('pgvector', {}).get('version') != '0.8.7':
            raise RuntimeError('Expected successful PostgreSQL 18/pgvector evidence')
        report['database'] = {'pass': True, 'version': database['version'],
                              'imageId': pg_image, 'runtime': host_runtime(pg_container)}
        report['complete'] = True
    finally:
        if active is not None:
            command(['docker', 'stop', '--time', '2', active], timeout=10, check=False)
        (root / 'followup.json').write_text(json.dumps(report, indent=2) + '\n')
        print(f'Retained evidence: {root}', flush=True)
        print('No containers/images/worktrees are deleted. All named probe containers should be stopped.', flush=True)
    print(f'Open the stopped task worktree on the host: code --new-window {tree}', flush=True)
    print('Verify editing fixture.txt and the task-only diff; report that manual result separately.', flush=True)
    print('Return followup.json, database.json and probe-sha256.json. This is still not a complete A2 GO.', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('offline_export', type=Path)
    args = parser.parse_args()
    run_followup(Path(__file__).resolve().parents[3], args.offline_export.resolve())
