import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { dirname, basename, join } from 'node:path';
import type { Environment, EnvironmentConfig } from './types.js';
import { run, type Run } from './system.js';

// Worker search/image review: docs/experiments/b2-worker-image/review.json.
export const reviewedImages = {
  worker:
    'sha256:612b2be5a3d9d21d79030001f74b89870db1fe0af923847afa88629500a1cafc',
  database:
    'sha256:42f51c32e76023298c26768b79fc32456feb4e49765fcf31b391891d4d7095db',
};
const script = (name: string) =>
  readFileSync(
    new URL(`../../runtime/environment/${name}.py`, import.meta.url),
    'utf8',
  );
export function profileIdentity(): string {
  return createHash('sha256')
    .update(readFileSync(new URL(import.meta.url)))
    .update(script('database'))
    .update(script('worker'))
    .update(script('model_gateway'))
    .digest('hex');
}
export class DockerRuntime {
  constructor(readonly execute: Run = run) {}
  preflight(config: EnvironmentConfig): void {
    if (!process.getuid?.() || process.getuid() === 999)
      throw new Error(
        'Supervisor must be non-root and distinct from database UID 999',
      );
    if (
      config.workerImage !== reviewedImages.worker ||
      config.databaseImage !== reviewedImages.database
    )
      throw new Error('Unreviewed runtime image refused');
    if (this.execute('docker', ['info', '--format', '{{.OSType}}']) !== 'linux')
      throw new Error('A Linux Docker engine is required');
    for (const image of [config.workerImage, config.databaseImage])
      if (
        this.execute('docker', [
          'image',
          'inspect',
          '--format',
          '{{.Id}}',
          image,
        ]) !== image
      )
        throw new Error('Image identity mismatch');
    if (
      readdirSync(config.shared).join() !== 'attachment.txt' ||
      lstatSync(join(config.shared, 'attachment.txt')).isSymbolicLink() ||
      readFileSync(join(config.shared, 'attachment.txt'), 'utf8') !==
        'synthetic attachment\n'
    )
      throw new Error(
        'Only the constrained synthetic attachment fixture is supported',
      );
    if (
      readdirSync(config.modelGateway).join() !== 'ollama.sock' ||
      !lstatSync(join(config.modelGateway, 'ollama.sock')).isSocket()
    )
      throw new Error('Missing isolated model gateway socket');
  }
  gatewayIdentity(config: EnvironmentConfig, model: string): string {
    const path = join(
      dirname(config.modelGateway),
      basename(config.modelGateway) + '.gateway.json',
    );
    const metadata = lstatSync(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== process.getuid?.() ||
      metadata.mode & 0o077
    )
      throw new Error('Gateway supervisor manifest is not private');
    const raw = readFileSync(path, 'utf8');
    const identity = JSON.parse(raw) as {
      pid: number;
      start: string;
      device: number;
      inode: number;
      uid: number;
      model: string;
      scriptHash: string;
    };
    const socket = lstatSync(join(config.modelGateway, 'ollama.sock'));
    if (
      !Number.isSafeInteger(identity.pid) ||
      identity.pid < 1 ||
      identity.model !== model ||
      identity.uid !== process.getuid?.() ||
      socket.dev !== identity.device ||
      socket.ino !== identity.inode ||
      identity.scriptHash !==
        createHash('sha256').update(script('model_gateway')).digest('hex') ||
      readFileSync(`/proc/${identity.pid}/stat`, 'utf8')
        .trim()
        .split(/\s+/)[21] !== identity.start
    )
      throw new Error(
        'Model gateway identity changed or is not the reviewed supervisor service',
      );
    return createHash('sha256').update(raw).digest('hex');
  }
  #restricted(environment: Environment, name: string): string[] {
    return [
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
    ];
  }
  database(environment: Environment, control: string, save: () => void): void {
    const { resources, config } = environment;
    this.execute('docker', [
      'volume',
      'create',
      '--label',
      `code-foundry.owner=${environment.owner}`,
      resources.volumeName,
    ]);
    environment.volumeIdentity = this.execute('docker', [
      'volume',
      'inspect',
      '--format',
      '{{.CreatedAt}}|{{.Driver}}|{{.Mountpoint}}',
      resources.volumeName,
    ]);
    save();
    this.verifyVolume(environment);
    const gateway = join(control, 'db-gateway');
    const service = join(control, 'database');
    for (const directory of [gateway, service]) {
      mkdirSync(directory, { mode: 0o777 });
      chmodSync(directory, 0o777);
    }
    const id = this.execute('docker', [
      ...this.#restricted(environment, resources.databaseName),
      '--user',
      '999:999',
      '--env',
      `CF_OWNER=${environment.owner}`,
      '--mount',
      `type=volume,source=${resources.volumeName},target=/var/lib/postgresql`,
      '--mount',
      `type=bind,source=${gateway},target=/frontend`,
      '--mount',
      `type=bind,source=${service},target=/control`,
      '--entrypoint',
      'python3',
      config.databaseImage,
      '-c',
      script('database'),
    ]);
    if (!/^[a-f0-9]{64}$/.test(id))
      throw new Error('Invalid database container identity');
    resources.databaseId = id;
    save(); // Persist identity before starting the service.
    this.verifyContainer(environment, id, 'database', control, 'created');
    this.execute('docker', ['start', id]);
    this.verifyContainer(environment, id, 'database', control);
    // A bounded exec waits inside the service namespace; no host sleep or daemon.
    this.execute('docker', [
      'exec',
      id,
      'python3',
      '-c',
      "import pathlib,time; p=pathlib.Path('/control/ready.json'); end=time.monotonic()+90\nwhile not p.exists():\n assert time.monotonic()<end; time.sleep(.1)",
    ]);
    const data = JSON.parse(
      readFileSync(join(service, 'ready.json'), 'utf8'),
    ) as Record<string, unknown>;
    if (
      data.ready !== true ||
      data.serviceUid !== 999 ||
      JSON.stringify(data.sourceInventory) !==
        JSON.stringify(data.cloneInventory)
    )
      throw new Error('Database snapshot inventory or identity failed');
    environment.database = data;
    copyFileSync(
      join(service, 'client.json'),
      join(environment.root, 'database.json'),
    );
    chmodSync(join(environment.root, 'database.json'), 0o600);
    save();
  }
  verifyVolume(environment: Environment): void {
    const label = this.execute('docker', [
      'volume',
      'inspect',
      '--format',
      '{{index .Labels "code-foundry.owner"}}',
      environment.resources.volumeName,
    ]);
    if (
      !environment.volumeIdentity ||
      this.execute('docker', [
        'volume',
        'inspect',
        '--format',
        '{{.CreatedAt}}|{{.Driver}}|{{.Mountpoint}}',
        environment.resources.volumeName,
      ]) !== environment.volumeIdentity ||
      label !== environment.owner
    )
      throw new Error('Volume ownership mismatch');
  }
  verifyContainer(
    environment: Environment,
    id: string,
    kind: 'database' | 'worker',
    control: string,
    phase: 'created' | 'started' = 'started',
  ): void {
    // Filtered inspection excludes environment values and command lines.
    const raw = this.execute('docker', [
      'inspect',
      '--format',
      '{"id":{{json .Id}},"state":{{json .State.Status}},"image":{{json .Image}},"owner":{{json (index .Config.Labels "code-foundry.owner")}},"user":{{json .Config.User}},"host":{{json .HostConfig}},"mounts":{{json .Mounts}},"apparmor":{{json .AppArmorProfile}}}',
      id,
    ]);
    const data = JSON.parse(raw) as {
      id: string;
      state: string;
      image: string;
      owner: string;
      user: string;
      host: {
        Privileged: boolean;
        ReadonlyRootfs: boolean;
        NetworkMode: string;
        PidMode: string;
        IpcMode: string;
        CgroupnsMode: string;
        DeviceRequests: unknown[] | null;
        CapDrop: string[];
        CapAdd: string[] | null;
        SecurityOpt: string[];
        Memory: number;
        MemorySwap: number;
        NanoCpus: number;
        PidsLimit: number;
        Devices: unknown[];
        Binds: unknown[] | null;
        PortBindings: unknown;
        Tmpfs: Record<string, string>;
        Ulimits: { Name: string; Hard: number; Soft: number }[];
      };
      mounts: {
        Type: string;
        Source: string;
        Destination: string;
        RW: boolean;
        Name?: string;
      }[];
      apparmor: string;
    };
    const h = data.host;
    if (
      data.id !== id ||
      data.owner !== environment.owner ||
      data.image !==
        (kind === 'worker'
          ? environment.config.workerImage
          : environment.config.databaseImage) ||
      data.user !==
        (kind === 'worker'
          ? `${process.getuid?.()}:${process.getgid?.()}`
          : '999:999') ||
      h.Privileged ||
      !h.ReadonlyRootfs ||
      h.NetworkMode !== 'none' ||
      !['', 'private'].includes(h.PidMode) ||
      h.IpcMode !== 'private' ||
      h.CgroupnsMode !== 'private' ||
      h.DeviceRequests?.length ||
      h.CapDrop?.join() !== 'ALL' ||
      h.CapAdd?.length ||
      h.SecurityOpt?.toSorted().join() !==
        'apparmor=docker-default,no-new-privileges=true' ||
      (phase === 'created'
        ? data.state !== 'created' ||
          !['', 'docker-default'].includes(data.apparmor)
        : !['running', 'exited'].includes(data.state) ||
          data.apparmor !== 'docker-default') ||
      h.Memory !== 4294967296 ||
      h.MemorySwap !== h.Memory ||
      h.NanoCpus !== 2000000000 ||
      h.PidsLimit !== 128 ||
      h.Devices?.length ||
      h.Binds?.length ||
      Object.keys(h.PortBindings ?? {}).length ||
      Object.keys(h.Tmpfs ?? {}).join() !== '/tmp' ||
      h.Tmpfs['/tmp'] !== 'rw,nosuid,nodev,noexec,size=512m,mode=1777' ||
      !h.Ulimits?.some(
        (limit) =>
          limit.Name === 'core' && limit.Hard === 0 && limit.Soft === 0,
      )
    )
      throw new Error('Runtime security profile mismatch');
    const expected =
      kind === 'worker'
        ? ([
            [environment.root, environment.root, true],
            [environment.config.shared, '/shared', false],
            [join(control, 'db-gateway'), '/gateways/db', false],
            [environment.config.modelGateway, '/gateways/model', false],
          ] as const)
        : ([
            [join(control, 'database'), '/control', true],
            [join(control, 'db-gateway'), '/frontend', true],
          ] as const);
    const binds = data.mounts.filter((m) => m.Type === 'bind');
    if (
      binds.length !== expected.length ||
      expected.some(
        ([source, destination, rw]) =>
          !binds.some(
            (m) =>
              m.Source === source &&
              m.Destination === destination &&
              m.RW === rw,
          ),
      )
    )
      throw new Error('Runtime mount mismatch');
    const volumes = data.mounts.filter((m) => m.Type !== 'bind');
    if (
      kind === 'worker'
        ? volumes.length !== 0
        : volumes.length !== 1 ||
          volumes[0]?.Name !== environment.resources.volumeName ||
          volumes[0]?.Destination !== '/var/lib/postgresql'
    )
      throw new Error('Unexpected runtime storage');
  }
  probe(
    environment: Environment,
    control: string,
    model: string,
    save: () => void,
  ): void {
    const id = this.execute('docker', [
      ...this.#restricted(environment, environment.resources.workerName),
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
      '--env',
      `HOME=${environment.root}/home`,
      '--env',
      `XDG_CACHE_HOME=${environment.root}/cache`,
      '--workdir',
      environment.worktree,
      '--entrypoint',
      'python3',
      environment.config.workerImage,
      '-c',
      script('worker'),
      environment.root,
      environment.base,
      model,
      environment.config.source,
      '9',
    ]);
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid worker identity');
    environment.resources.workerId = id;
    save();
    this.verifyContainer(environment, id, 'worker', control, 'created');
    try {
      const result = JSON.parse(
        this.execute('docker', ['start', '--attach', id]),
      ) as { ready: boolean };
      this.verifyContainer(environment, id, 'worker', control);
      const exit = this.execute('docker', [
        'inspect',
        '--format',
        '{{.State.ExitCode}}',
        id,
      ]);
      if (!result.ready || exit !== '0')
        throw new Error('Worker readiness failed');
    } finally {
      // Whole-container stop, even if the Docker client times out. Never remove.
      this.execute('docker', ['stop', '--time', '2', id]);
      this.#assertStopped(id);
    }
  }
  #assertStopped(id: string): void {
    if (
      this.execute('docker', [
        'inspect',
        '--format',
        '{{.State.Running}}',
        id,
      ]) !== 'false'
    )
      throw new Error('Worker termination unverified');
  }
  readiness(environment: Environment, control: string): void {
    this.preflight(environment.config);
    if (
      this.gatewayIdentity(environment.config, environment.model) !==
      environment.gatewayIdentity
    )
      throw new Error('Model gateway ownership mismatch');
    this.verifyVolume(environment);
    if (
      !environment.resources.databaseId ||
      !environment.resources.workerId ||
      !environment.database
    )
      throw new Error('Incomplete environment ownership');
    this.verifyContainer(
      environment,
      environment.resources.databaseId,
      'database',
      control,
    );
    this.verifyContainer(
      environment,
      environment.resources.workerId,
      'worker',
      control,
    );
    if (
      this.execute('docker', [
        'inspect',
        '--format',
        '{{.State.Running}}',
        environment.resources.databaseId,
      ]) !== 'true' ||
      this.execute('docker', [
        'inspect',
        '--format',
        '{{.State.Running}}',
        environment.resources.workerId,
      ]) !== 'false'
    )
      throw new Error('Unexpected service or worker state');
    const live = JSON.parse(
      this.execute('docker', [
        'exec',
        environment.resources.databaseId,
        'python3',
        '-c',
        script('database'),
        '--check',
      ]),
    ) as Record<string, unknown>;
    if (
      JSON.stringify(live.identity) !==
        JSON.stringify(environment.database.identity) ||
      JSON.stringify(live.sourceInventory) !==
        JSON.stringify(environment.database.sourceInventory)
    )
      throw new Error('Database ownership or source inventory mismatch');
    // Rerun the existing stopped probe; retain its immutable identity.
    try {
      const result = JSON.parse(
        this.execute('docker', [
          'start',
          '--attach',
          environment.resources.workerId,
        ]),
      ) as { ready: boolean };
      this.verifyContainer(
        environment,
        environment.resources.workerId,
        'worker',
        control,
      );
      if (
        !result.ready ||
        this.execute('docker', [
          'inspect',
          '--format',
          '{{.State.ExitCode}}',
          environment.resources.workerId,
        ]) !== '0'
      )
        throw new Error('Readiness probe failed');
    } finally {
      this.execute('docker', [
        'stop',
        '--time',
        '2',
        environment.resources.workerId,
      ]);
      this.#assertStopped(environment.resources.workerId);
    }
  }
}
