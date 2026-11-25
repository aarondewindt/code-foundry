import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { DockerRuntime } from '../environment/runtime.js';
import type { Environment } from '../environment/types.js';
import type { ExecutionAction } from '../queue/store.js';
import { capture, type ProcessResult } from './process.js';

export class ExecutionRuntime {
  constructor(readonly docker = new DockerRuntime()) {}
  reconcile(
    environment: Environment,
    attemptId: string,
    containers: string[],
    force: boolean,
    expectedDaemon?: string,
    bindDaemon?: (daemon: string) => void,
  ): string[] {
    if (!/^[0-9a-f-]{36}$/.test(attemptId))
      throw new Error('Invalid execution attempt identity');
    const daemon = this.daemonIdentity();
    if (expectedDaemon && expectedDaemon !== daemon)
      throw new Error('Execution Docker daemon identity changed');
    const listed = this.docker.execute('docker', [
      'ps',
      '-a',
      '--no-trunc',
      '--filter',
      `label=code-foundry.owner=${environment.owner}`,
      '--format',
      '{{.ID}} {{.Names}}',
    ]);
    const names = new RegExp(
      `^cf-(?:before|diff)-${attemptId}(?:-status)?$|^cf-review-(?:snapshot|baseline)-${attemptId}$|^cf-(?:code|test)-${attemptId}-[0-9]+(?:-[0-9]+)?$`,
    );
    const found = new Set<string>();
    for (const line of listed.split('\n').filter(Boolean)) {
      const [id, name] = line.split(' ');
      if (!id || !name || !/^[a-f0-9]{64}$/.test(id))
        throw new Error('Invalid Docker inventory');
      if (!names.test(name)) {
        if (containers.includes(id))
          throw new Error('Execution container ownership mismatch');
        continue;
      }
      found.add(id);
    }
    if (!expectedDaemon && containers.some((id) => !found.has(id)))
      throw new Error('Cannot establish daemon ownership for legacy execution');
    bindDaemon?.(daemon);
    for (const id of found) {
      this.docker.execute('docker', ['stop', '--time', force ? '0' : '2', id]);
      this.docker.execute('docker', ['rm', id]);
    }
    // Inspect the full inventory to reject a recorded ID with a changed label.
    const remaining = this.docker
      .execute('docker', ['ps', '-a', '--no-trunc', '--format', '{{.ID}}'])
      .split('\n');
    if (
      this.daemonIdentity() !== daemon ||
      [...containers, ...found].some((id) => remaining.includes(id))
    )
      throw new Error('Execution termination could not be verified');
    return [...found];
  }
  private daemonIdentity(): string {
    const daemon = this.docker.execute('docker', [
      'info',
      '--format',
      '{{.ID}}',
    ]);
    if (!daemon || daemon === '<no value>')
      throw new Error('Missing Docker daemon identity');
    return daemon;
  }
  async run(
    environment: Environment,
    control: string,
    name: string,
    settings: Record<string, unknown>,
    prefix: string,
    deadline: number,
    reserved: (id: string, daemon?: string) => void,
    onLine?: (line: string) => void,
    action?: () => ExecutionAction | undefined,
  ): Promise<ProcessResult> {
    if (action?.()) {
      const now = new Date().toISOString();
      return {
        exit: null,
        signal: null,
        limited: true,
        limitReason: 'control',
        startedAt: now,
        finishedAt: now,
      };
    }
    if (Date.now() >= deadline)
      throw new Error('Execution deadline exhausted before create');
    const id = this.docker.execute('docker', [
      'create',
      '--name',
      name,
      '--pull=never',
      '--init',
      '--label',
      `code-foundry.owner=${environment.owner}`,
      '--network',
      'none',
      '--ipc',
      'private',
      '--cgroupns',
      'private',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges=true',
      '--security-opt',
      'apparmor=docker-default',
      '--cpus',
      '2',
      '--memory',
      '4g',
      '--memory-swap',
      '4g',
      '--pids-limit',
      '128',
      '--ulimit',
      'core=0',
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,noexec,size=512m,mode=1777',
      '--user',
      `${process.getuid?.()}:${process.getgid?.()}`,
      '--mount',
      `type=bind,source=${environment.root},target=${environment.root}`,
      '--mount',
      `type=bind,source=${environment.config.shared},target=/shared,readonly,bind-recursive=disabled`,
      '--mount',
      `type=bind,source=${join(control, 'db-gateway')},target=/gateways/db,readonly`,
      '--mount',
      `type=bind,source=${environment.config.modelGateway},target=/gateways/model,readonly`,
      '--workdir',
      environment.worktree,
      '--entrypoint',
      'timeout',
      environment.config.workerImage,
      '--signal=TERM',
      '--kill-after=2s',
      `${Math.max(1, Math.ceil((deadline - Date.now()) / 1000))}s`,
      'python3',
      '-I',
      '-c',
      readFileSync(
        new URL('../../runtime/execution/worker.py', import.meta.url),
        'utf8',
      ),
      Buffer.from(
        JSON.stringify({ ...settings, root: environment.root }),
      ).toString('base64'),
    ]);
    if (!/^[a-f0-9]{64}$/.test(id))
      throw new Error('Invalid execution container identity');
    reserved(id, this.daemonIdentity()); // Before start: a crash never makes this a replayable launch.
    this.docker.verifyContainer(environment, id, 'worker', control, 'created');
    // Independent supervisor-side deadline survives controller loss. The worker
    // cannot signal it or access its Docker authority. Never select by a prefix.
    const guard = spawn(
      'python3',
      [
        '-c',
        `import subprocess,sys,time
time.sleep(max(0,float(sys.argv[2])-time.time()))
subprocess.run(['docker','stop','--time','2',sys.argv[1]],timeout=15,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
`,
        id,
        String(deadline / 1000),
      ],
      {
        detached: true,
        stdio: 'ignore',
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: '/nonexistent',
        },
      },
    );
    await new Promise<void>((resolve, reject) => {
      guard.once('spawn', resolve);
      guard.once('error', reject);
    });
    writeFileSync(
      `${prefix}.guard.json`,
      JSON.stringify({
        container: id,
        deadline,
        pid: guard.pid,
        start: readFileSync(`/proc/${guard.pid}/stat`, 'utf8')
          .trim()
          .split(/\s+/)[21],
      }),
      { flag: 'wx', mode: 0o600 },
    );
    guard.unref();
    let terminationVerified = false;
    try {
      const result = await capture(
        'docker',
        ['start', '--attach', id],
        prefix,
        deadline,
        onLine,
        action && (() => action() !== undefined),
      );
      this.docker.verifyContainer(environment, id, 'worker', control);
      const wasRunning =
        this.docker.execute('docker', [
          'inspect',
          '--format',
          '{{.State.Running}}',
          id,
        ]) !== 'false';
      const exit = Number(
        this.docker.execute('docker', [
          'inspect',
          '--format',
          '{{.State.ExitCode}}',
          id,
        ]),
      );
      this.docker.execute('docker', [
        'stop',
        '--time',
        action?.() === 'force-stop' ? '0' : '2',
        id,
      ]);
      if (
        this.docker.execute('docker', [
          'inspect',
          '--format',
          '{{.State.Running}}',
          id,
        ]) !== 'false'
      )
        throw new Error(
          'Execution termination unverified; retain active claim',
        );
      terminationVerified = true;
      guard.kill('SIGTERM');
      return {
        ...result,
        limited: result.limited || wasRunning,
        exit: result.exit === 0 ? exit : result.exit,
      };
    } finally {
      if (!terminationVerified) {
        this.docker.execute('docker', ['stop', '--time', '2', id]);
      }
    }
  }
}
