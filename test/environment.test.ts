import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareGit, verifyGit } from '../src/environment/git.js';
import { EnvironmentManager } from '../src/environment/manager.js';
import {
  DockerRuntime,
  profileIdentity,
  reviewedImages,
} from '../src/environment/runtime.js';
import { readEnvironmentConfig } from '../src/environment/system.js';
import type {
  Environment,
  EnvironmentConfig,
} from '../src/environment/types.js';
import type { Project } from '../src/queue/config.js';
import type { IssueSnapshot } from '../src/queue/github.js';
import { QueueStore } from '../src/queue/store.js';

const roots: string[] = [];
const stores: QueueStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cf-environment-test-'));
  roots.push(root);
  const source = join(root, 'source');
  mkdirSync(source);
  mkdirSync(join(root, 'tasks'));
  mkdirSync(join(root, 'private'));
  mkdirSync(join(root, 'shared'));
  mkdirSync(join(root, 'model'));
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
        },
      },
    ).trim();
  git('init', '-q', '--initial-branch=main', source);
  writeFileSync(
    join(source, '.code-foundry-synthetic'),
    'code-foundry-synthetic-v1\n',
  );
  writeFileSync(join(source, 'fixture.txt'), 'committed\n');
  git('-C', source, 'add', '.');
  // Authorized disposable seed fixture only; never commits to the real checkout.
  git(
    '-C',
    source,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture',
  );
  const base = git('-C', source, 'rev-parse', 'HEAD');
  writeFileSync(join(source, 'fixture.txt'), 'uncommitted source work\n');
  writeFileSync(join(source, 'untracked.txt'), 'preserve me');
  const config: EnvironmentConfig = {
    source,
    shared: join(root, 'shared'),
    modelGateway: join(root, 'model'),
    workerImage: reviewedImages.worker,
    databaseImage: reviewedImages.database,
  };
  const project: Project = {
    repository: 'fixture/project',
    taskRoot: join(root, 'tasks'),
    validation: [['node', '--test']],
    serviceRefs: {},
    defaultProfile: 'local',
    profiles: {
      local: {
        agent: 'build',
        provider: 'ollama',
        model: 'gpt-oss:20b',
        runtimeSeconds: 120,
        maxToolCalls: 20,
        maxRepairs: 0,
      },
    },
    allowedOverrides: [],
  };
  const issue = (number = 1): IssueSnapshot => ({
    repository: 'fixture/project',
    number,
    url: `https://github.com/fixture/project/issues/${number}`,
    title: 'Synthetic fixture',
    body: 'Implement',
    state: 'open',
    labels: [],
    comments: [],
    milestone: null,
    blockers: [],
    dependenciesVerified: true,
    dependencyLimitation: null,
    fetchedAt: new Date().toISOString(),
  });
  const path = join(root, 'private/state.sqlite');
  const store = new QueueStore(path);
  stores.push(store);
  return { root, source, base, config, project, issue, path, store, git };
}
function environment(f: ReturnType<typeof fixture>, name: string): Environment {
  const root = join(f.root, 'tasks', name);
  mkdirSync(root);
  return {
    taskId: name,
    attemptId: 'attempt',
    owner: name,
    status: 'preparing',
    stage: 'git',
    error: null,
    createdAt: 'now',
    updatedAt: 'now',
    root,
    worktree: join(root, 'worktree'),
    branch: `task-${name}`,
    base: f.base,
    config: f.config,
    profileHash: profileIdentity(),
    model: 'gpt-oss:20b',
    resources: {
      databaseName: 'db',
      workerName: 'worker',
      volumeName: 'volume',
    },
    ports: { application: 3000, postgres: 6432, model: 4111 },
  };
}
class FailureRuntime extends DockerRuntime {
  override preflight(): void {
    throw new Error('synthetic-secret must not leak');
  }
}
class GitThenFailure extends DockerRuntime {
  override gatewayIdentity(): string {
    return 'synthetic-gateway';
  }
  override preflight(): void {}
  override database(): void {
    throw new Error('restore secret');
  }
}

describe('real independent Git storage', () => {
  it('prepares two tasks from the exact commit, preserves dirty source and permits independent edits', () => {
    const f = fixture();
    const before = f.git('-C', f.source, 'status', '--porcelain=v1');
    const first = environment(f, 'first'),
      second = environment(f, 'second');
    prepareGit(first);
    prepareGit(second);
    expect(readFileSync(join(first.worktree, 'fixture.txt'), 'utf8')).toBe(
      'committed\n',
    );
    writeFileSync(join(first.worktree, 'fixture.txt'), 'task only\n');
    expect(f.git('-C', first.worktree, 'diff')).toContain('+task only');
    verifyGit(first);
    verifyGit(second);
    expect(f.git('-C', f.source, 'status', '--porcelain=v1')).toBe(before);
    expect(f.git('-C', f.source, 'branch', '--show-current')).toBe('main');
    expect(readFileSync(join(f.source, 'fixture.txt'), 'utf8')).toBe(
      'uncommitted source work\n',
    );
    expect(readFileSync(join(second.worktree, 'fixture.txt'), 'utf8')).toBe(
      'committed\n',
    );
    expect(f.git('-C', first.worktree, 'remote')).toBe('');
    const object = f.git(
      '--git-dir',
      join(first.root, 'store.git'),
      'rev-parse',
      '--git-path',
      'objects',
    );
    expect(object).toBe(join(first.root, 'store.git/objects'));
  });
  it('refuses object alternates and symlink metadata instead of trusting a prefix', () => {
    const f = fixture();
    const env = environment(f, 'linked');
    prepareGit(env);
    writeFileSync(
      join(env.root, 'store.git/objects/info/alternates'),
      join(f.source, '.git/objects'),
    );
    expect(() => verifyGit(env)).toThrow('Shared or linked');
    rmSync(join(env.root, 'store.git/objects/info/alternates'));
    symlinkSync(
      join(f.source, '.git/config'),
      join(env.root, 'store.git/evil'),
    );
    expect(() => verifyGit(env)).toThrow('Shared or linked');
  });
});

describe('environment lifecycle and fail-closed preparation', () => {
  it('persists preflight failure and ownership across restart; refuses replay and leaks no service errors', () => {
    const f = fixture();
    const task = f.store.enqueue(f.issue(), f.project, 'user approval');
    const manager = new EnvironmentManager(
      f.store,
      f.path,
      new FailureRuntime(),
    );
    expect(() => manager.prepare(task.id, f.issue(), f.config)).toThrow(
      'security-preflight',
    );
    const env = f.store.environment(task.id)!;
    expect(env.status).toBe('failed');
    expect(JSON.stringify(f.store.events(task.id))).not.toContain(
      'synthetic-secret',
    );
    expect(
      statSync(join(manager.control(env), 'manifest.json')).mode & 0o777,
    ).toBe(0o600);
    const restarted = new QueueStore(f.path);
    stores.push(restarted);
    expect(restarted.environment(task.id)).toEqual(env);
    expect(restarted.get(task.id).status).toBe('running');
    expect(() =>
      new EnvironmentManager(restarted, f.path, new FailureRuntime()).prepare(
        task.id,
        f.issue(),
        f.config,
      ),
    ).toThrow('never replayed');
    expect(() => manager.recover(env, env.attemptId, 'wrong')).toThrow();
  });
  it('retains real Git output after a partial database failure and verifies inode ownership', () => {
    const f = fixture();
    const task = f.store.enqueue(f.issue(), f.project, 'user');
    const manager = new EnvironmentManager(
      f.store,
      f.path,
      new GitThenFailure(),
    );
    expect(() => manager.prepare(task.id, f.issue(), f.config)).toThrow(
      'database',
    );
    const env = f.store.environment(task.id)!;
    verifyGit(env);
    expect(readFileSync(join(env.root, 'environment.json'), 'utf8')).toContain(
      env.base,
    );
    expect(() =>
      manager.check({ ...env, filesystem: { device: 0, inode: 0 } }),
    ).toThrow('ownership');
    expect(JSON.stringify(env)).not.toContain('restore secret');
  });
  it('revalidates approval and blockers before reserving an environment', () => {
    const f = fixture();
    const task = f.store.enqueue(f.issue(), f.project, 'user');
    const manager = new EnvironmentManager(
      f.store,
      f.path,
      new FailureRuntime(),
    );
    expect(
      manager.prepare(task.id, { ...f.issue(), body: 'changed' }, f.config),
    ).toEqual({ blocked: true });
    expect(f.store.environment(task.id)).toBeNull();
    expect(
      manager.prepare(
        task.id,
        { ...f.issue(), dependenciesVerified: false },
        f.config,
      ),
    ).toEqual({ blocked: true });
    expect(f.store.attempts(task.id)).toHaveLength(0);
  });
  it('only releases the preparation reservation after durable readiness and protects attempt identity', () => {
    const f = fixture();
    const task = f.store.enqueue(f.issue(), f.project, 'user');
    const claim = f.store.claim(task.id, f.issue());
    if (!('token' in claim)) throw new Error('claim');
    const env = {
      ...environment(f, 'owned'),
      taskId: task.id,
      attemptId: claim.attemptId,
    };
    expect(() => f.store.reserveEnvironment(env, 'bad')).toThrow('ownership');
    f.store.reserveEnvironment(env, claim.token);
    expect(() =>
      f.store.saveEnvironment({ ...env, owner: 'other' }, claim.token),
    ).toThrow('mismatch');
    f.store.saveEnvironment({ ...env, status: 'ready' }, claim.token);
    expect(f.store.get(task.id).status).toBe('queued');
    const second = f.store.enqueue(f.issue(2), f.project, 'user');
    expect(f.store.claim(second.id, f.issue(2))).toHaveProperty('attemptId');
  });
  it('rejects malformed config and unreviewed images before any runtime mutation', () => {
    const f = fixture();
    const path = join(f.root, 'env.json');
    writeFileSync(path, JSON.stringify({ ...f.config, password: 'secret' }));
    expect(() => readEnvironmentConfig(path)).toThrow('Unsupported');
    writeFileSync(
      path,
      JSON.stringify({ ...f.config, source: f.source + '/../source' }),
    );
    expect(() => readEnvironmentConfig(path)).toThrow('canonical');
    let calls = 0;
    const runtime = new DockerRuntime(() => {
      calls++;
      return '';
    });
    expect(() =>
      runtime.preflight({
        ...f.config,
        workerImage: 'sha256:' + '0'.repeat(64),
      }),
    ).toThrow();
    expect(() =>
      runtime.preflight({
        ...f.config,
        workerImage:
          'sha256:ed438643c34417030e7043f07efe12b1756a0a3104b44610e800839a96e39d6b',
      }),
    ).toThrow('Unreviewed runtime image');
    expect(calls).toBe(0);
  });
  it('fails the real CLI readiness command when environment resources are absent', () => {
    const f = fixture();
    const task = f.store.enqueue(f.issue(), f.project, 'user');
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'readiness', task.id, '--db', f.path],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No environment reserved');
  });
});

describe('production model gateway', () => {
  it('blocks protected mock writes and enforces route, model, framing, concurrency and request budgets', () => {
    const result = spawnSync(
      'python3',
      [
        '-m',
        'unittest',
        'discover',
        '-s',
        'runtime/environment',
        '-p',
        'test_gateway.py',
      ],
      { encoding: 'utf8', timeout: 20_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('Ran 5 tests');
  }, 25_000);
});

describe('runtime rejection of tampered inspection data', () => {
  it('refuses unexpected network access, writable shared inputs, extra security options and unbounded resources', () => {
    const f = fixture();
    const env = environment(f, 'profile');
    const control = join(f.root, 'private/control');
    const id = 'a'.repeat(64);
    const inspect = {
      id,
      image: reviewedImages.worker,
      owner: env.owner,
      user: `${process.getuid?.()}:${process.getgid?.()}`,
      apparmor: 'docker-default',
      state: 'running',
      host: {
        Privileged: false,
        ReadonlyRootfs: true,
        NetworkMode: 'none',
        PidMode: '',
        IpcMode: 'private',
        CgroupnsMode: 'private',
        CapDrop: ['ALL'],
        CapAdd: null,
        SecurityOpt: ['no-new-privileges=true', 'apparmor=docker-default'],
        Memory: 4294967296,
        MemorySwap: 4294967296,
        NanoCpus: 2000000000,
        PidsLimit: 128,
        Devices: [],
        DeviceRequests: null,
        Binds: null,
        PortBindings: {},
        Ulimits: [{ Name: 'core', Hard: 0, Soft: 0 }],
        Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=512m,mode=1777' },
      },
      mounts: [
        { Type: 'bind', Source: env.root, Destination: env.root, RW: true },
        {
          Type: 'bind',
          Source: env.config.shared,
          Destination: '/shared',
          RW: false,
        },
        {
          Type: 'bind',
          Source: join(control, 'db-gateway'),
          Destination: '/gateways/db',
          RW: false,
        },
        {
          Type: 'bind',
          Source: env.config.modelGateway,
          Destination: '/gateways/model',
          RW: false,
        },
      ],
    };
    const runtime = (value: unknown) =>
      new DockerRuntime(() => JSON.stringify(value));
    expect(() =>
      runtime(inspect).verifyContainer(env, id, 'worker', control),
    ).not.toThrow();
    // Docker can leave AppArmorProfile empty until startup. Only an explicitly
    // requested profile on a still-created container may pass creation checks.
    const created = { ...inspect, state: 'created', apparmor: '' };
    expect(() =>
      runtime(created).verifyContainer(env, id, 'worker', control, 'created'),
    ).not.toThrow();
    expect(() =>
      runtime(created).verifyContainer(env, id, 'worker', control),
    ).toThrow('security profile');
    expect(() =>
      runtime({ ...created, state: 'running' }).verifyContainer(
        env,
        id,
        'worker',
        control,
        'created',
      ),
    ).toThrow('security profile');
    expect(() =>
      runtime({ ...created, apparmor: 'unconfined' }).verifyContainer(
        env,
        id,
        'worker',
        control,
        'created',
      ),
    ).toThrow('security profile');
    expect(() =>
      runtime({
        ...created,
        host: { ...inspect.host, SecurityOpt: ['no-new-privileges=true'] },
      }).verifyContainer(env, id, 'worker', control, 'created'),
    ).toThrow('security profile');
    expect(() =>
      runtime({ ...inspect, apparmor: '' }).verifyContainer(
        env,
        id,
        'worker',
        control,
      ),
    ).toThrow('security profile');
    for (const host of [
      { ...inspect.host, NetworkMode: 'bridge' },
      { ...inspect.host, Privileged: true },
      { ...inspect.host, Memory: 0 },
      {
        ...inspect.host,
        SecurityOpt: ['no-new-privileges=true', 'seccomp=unconfined'],
      },
      { ...inspect.host, PidMode: 'host' },
    ])
      expect(() =>
        runtime({ ...inspect, host }).verifyContainer(
          env,
          id,
          'worker',
          control,
        ),
      ).toThrow('security profile');
    expect(() =>
      runtime({
        ...inspect,
        mounts: inspect.mounts.map((m) => ({ ...m, RW: true })),
      }).verifyContainer(env, id, 'worker', control),
    ).toThrow('mount');
    expect(() =>
      runtime({ ...inspect, owner: 'another task' }).verifyContainer(
        env,
        id,
        'worker',
        control,
      ),
    ).toThrow();
  });
});

describe('supervisor service identity and schema migration', () => {
  it('validates a real foreground gateway and rejects replacement identity', async () => {
    const f = fixture();
    const child = spawn(
      'python3',
      [
        'runtime/environment/model_gateway.py',
        f.config.modelGateway,
        'gpt-oss:20b',
      ],
      { stdio: 'ignore' },
    );
    const manifest = f.config.modelGateway + '.gateway.json';
    try {
      const end = Date.now() + 5000;
      while (!existsSync(manifest)) {
        if (Date.now() > end) throw new Error('Gateway startup timeout');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const runtime = new DockerRuntime();
      expect(runtime.gatewayIdentity(f.config, 'gpt-oss:20b')).toMatch(
        /^[a-f0-9]{64}$/,
      );
      expect(() => runtime.gatewayIdentity(f.config, 'another-model')).toThrow(
        'identity',
      );
      const original = JSON.parse(readFileSync(manifest, 'utf8')) as Record<
        string,
        unknown
      >;
      writeFileSync(manifest, JSON.stringify({ ...original, inode: 0 }));
      expect(() => runtime.gatewayIdentity(f.config, 'gpt-oss:20b')).toThrow(
        'identity',
      );
    } finally {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
  }, 10_000);
  it('migrates an existing B1 schema without losing approved tasks or events', () => {
    const f = fixture();
    const task = f.store.enqueue(f.issue(), f.project, 'user');
    const sqlite = new DatabaseSync(f.path);
    sqlite.exec('DROP TABLE environments; PRAGMA user_version=1;');
    sqlite.close();
    const upgraded = new QueueStore(f.path);
    stores.push(upgraded);
    expect(upgraded.get(task.id)).toEqual(task);
    expect(upgraded.events(task.id)).toHaveLength(1);
    expect(upgraded.environment(task.id)).toBeNull();
  });
});
