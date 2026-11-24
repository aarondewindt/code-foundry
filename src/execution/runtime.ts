import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { DockerRuntime } from '../environment/runtime.js';
import type { Environment } from '../environment/types.js';
import { capture, type ProcessResult } from './process.js';

export class ExecutionRuntime {
  constructor(readonly docker = new DockerRuntime()) {}
  async run(
    environment: Environment,
    control: string,
    name: string,
    settings: Record<string, unknown>,
    prefix: string,
    deadline: number,
    reserved: (id: string) => void,
    onLine?: (line: string) => void,
  ): Promise<ProcessResult> {
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
    reserved(id); // Before start: a crash never makes this a replayable launch.
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
      this.docker.execute('docker', ['stop', '--time', '2', id]);
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
