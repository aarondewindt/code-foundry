import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { IssueSnapshot } from '../queue/github.js';
import type { QueueStore } from '../queue/store.js';
import { prepareGit, verifyGit } from './git.js';
import { DockerRuntime, profileIdentity } from './runtime.js';
import { canonical, git, within } from './system.js';
import type { Environment, EnvironmentConfig } from './types.js';

export class EnvironmentManager {
  constructor(
    readonly store: QueueStore,
    readonly statePath: string,
    readonly runtime = new DockerRuntime(),
  ) {}
  control(environment: Environment): string {
    return join(
      dirname(resolve(this.statePath)),
      'environments',
      environment.owner,
    );
  }
  #manifest(environment: Environment): void {
    const directory = this.control(environment);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `manifest-${randomUUID()}.json`);
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(environment, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, join(directory, 'manifest.json'));
    const parent = openSync(directory, 'r');
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  }
  prepare(
    taskId: string,
    fresh: IssueSnapshot,
    config: EnvironmentConfig,
  ): Environment | { blocked: true } {
    if (this.store.environment(taskId))
      throw new Error(
        'Environment already reserved; inspect/check or explicitly reconcile it. Provisioning is never replayed',
      );
    const task = this.store.get(taskId);
    const taskRoot = canonical(task.project.taskRoot);
    const stateRoot = canonical(dirname(resolve(this.statePath)));
    for (const other of [
      config.source,
      config.shared,
      config.modelGateway,
      stateRoot,
    ])
      if (within(taskRoot, other) || within(other, taskRoot))
        throw new Error(
          'Task root must be separate from source, shared inputs, gateways and supervisor state',
        );
    if (
      readFileSync(join(config.source, '.code-foundry-synthetic'), 'utf8') !==
      'code-foundry-synthetic-v1\n'
    )
      throw new Error(
        'Only an explicitly marked synthetic source project is supported',
      );
    const base = git([
      '-C',
      config.source,
      'rev-parse',
      '--verify',
      'HEAD^{commit}',
    ]);
    if (!/^[a-f0-9]{40,64}$/.test(base))
      throw new Error('Invalid source commit');
    const claim = this.store.claim(taskId, fresh);
    if ('blocked' in claim) return { blocked: true };
    const owner = randomUUID();
    const root = join(taskRoot, owner);
    const now = new Date().toISOString();
    const environment: Environment = {
      taskId,
      attemptId: claim.attemptId,
      owner,
      status: 'preparing',
      stage: 'reserved',
      error: null,
      createdAt: now,
      updatedAt: now,
      root,
      worktree: join(root, 'worktree'),
      branch: `cf-task-${owner}`,
      base,
      config,
      profileHash: profileIdentity(),
      model: task.profile.model,
      resources: {
        databaseName: `cf-db-${owner}`,
        workerName: `cf-check-${owner}`,
        volumeName: `cf-data-${owner}`,
      },
      // Private network namespaces permit identical ports without host publication.
      ports: { application: 3000, postgres: 6432, model: 4111 },
    };
    this.store.reserveEnvironment(environment, claim.token);
    const save = () => {
      environment.updatedAt = new Date().toISOString();
      this.#manifest(environment);
      this.store.saveEnvironment(environment, claim.token);
    };
    try {
      this.#manifest(environment);
      environment.stage = 'security-preflight';
      save();
      this.runtime.preflight(config);
      environment.gatewayIdentity = this.runtime.gatewayIdentity(
        config,
        task.profile.model,
      );
      if (
        this.store
          .list()
          .some(
            (other) =>
              this.store.environment(other.id)?.gatewayIdentity ===
                environment.gatewayIdentity && other.id !== taskId,
          )
      )
        throw new Error('Model gateway is already owned by another task');
      save();
      environment.stage = 'git';
      save();
      mkdirSync(root, { mode: 0o700 });
      const metadata = lstatSync(root);
      environment.filesystem = { device: metadata.dev, inode: metadata.ino };
      save();
      prepareGit(environment);
      writeFileSync(
        join(root, 'environment.json'),
        JSON.stringify(
          {
            taskId,
            attemptId: claim.attemptId,
            base,
            branch: environment.branch,
            ports: environment.ports,
            build: join(root, 'build'),
            cache: join(root, 'cache'),
            uploads: join(root, 'uploads'),
            databaseSocket: '/gateways/db',
            modelSocket: '/gateways/model/ollama.sock',
          },
          null,
          2,
        ),
        { flag: 'wx', mode: 0o600 },
      );
      environment.stage = 'database';
      save();
      this.runtime.database(environment, this.control(environment), save);
      environment.stage = 'worker-readiness';
      save();
      this.runtime.probe(
        environment,
        this.control(environment),
        task.profile.model,
        save,
      );
      this.check(environment);
      environment.stage = 'complete';
      environment.status = 'ready';
      save();
      return environment;
    } catch {
      // No raw errors from a restore, source repo, worker or service enter durable logs.
      environment.status = 'failed';
      environment.error = `Preparation failed at ${environment.stage}; resources retained. Inspect the supervisor manifest and service locally; provisioning will not be replayed.`;
      save();
      throw new Error(environment.error);
    }
  }
  check(environment: Environment): { ready: true; worktree: string } {
    if (environment.profileHash !== profileIdentity())
      throw new Error('Runtime profile changed; renewed verification required');
    const info = lstatSync(environment.root);
    if (
      info.isSymbolicLink() ||
      info.dev !== environment.filesystem?.device ||
      info.ino !== environment.filesystem.inode
    )
      throw new Error('Task filesystem ownership mismatch');
    verifyGit(environment);
    const manifest = JSON.parse(
      readFileSync(join(this.control(environment), 'manifest.json'), 'utf8'),
    ) as Environment;
    if (
      manifest.owner !== environment.owner ||
      manifest.attemptId !== environment.attemptId ||
      manifest.root !== environment.root
    )
      throw new Error('Supervisor manifest identity mismatch');
    this.runtime.readiness(environment, this.control(environment));
    return { ready: true, worktree: environment.worktree };
  }
  recover(
    environment: Environment,
    attemptId: string,
    token: string,
  ): Environment {
    this.store.assertEnvironmentOwner(environment.taskId, attemptId, token);
    if (environment.status === 'ready')
      throw new Error('Environment already ready');
    if (environment.attemptId !== attemptId)
      throw new Error('Attempt identity mismatch');
    // Recovery only rechecks already created resources; no clone/restore/recreation.
    this.check(environment);
    environment.status = 'ready';
    environment.stage = 'recovered';
    environment.error = null;
    environment.updatedAt = new Date().toISOString();
    this.store.saveEnvironment(environment, token);
    this.#manifest(environment);
    return environment;
  }
}
