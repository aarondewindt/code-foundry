/** Shared real Git/Docker/PG18 fixture; callers select retention explicitly. */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { strict as assert } from 'node:assert';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EnvironmentManager } from '../src/environment/manager.js';
import { DockerRuntime, reviewedImages } from '../src/environment/runtime.js';
import { QueueStore } from '../src/queue/store.js';
import type { Project } from '../src/queue/config.js';
import type { IssueSnapshot } from '../src/queue/github.js';

export async function runEnvironmentFixture(options: {
  retainGateways: boolean;
  reportPath?: string;
  verifyFailures?: boolean;
}) {
  const gateways: ChildProcess[] = [];
  const root = mkdtempSync(join(tmpdir(), 'cf-b2-fixture-'));
  console.log(`Retained integration root: ${root}`);
  for (const name of [
    'source',
    'tasks',
    'private',
    'shared',
    'model1',
    'model2',
  ])
    mkdirSync(join(root, name), { mode: 0o700 });
  const source = join(root, 'source');
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
  writeFileSync(join(source, 'fixture.txt'), 'synthetic source\n');
  git('-C', source, 'add', '.');
  git(
    '-C',
    source,
    '-c',
    'user.name=B2 Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'Disposable synthetic integration seed',
  );
  writeFileSync(join(source, 'fixture.txt'), 'uncommitted source edits\n');
  writeFileSync(join(root, 'shared/attachment.txt'), 'synthetic attachment\n');
  const original = git('-C', source, 'status', '--porcelain');
  const db = join(root, 'private/state.sqlite');
  let store = new QueueStore(db);
  const project: Project = {
    repository: 'synthetic/fixture',
    taskRoot: join(root, 'tasks'),
    validation: [['node', '--test']],
    serviceRefs: { database: 'synthetic-only' },
    defaultProfile: 'local',
    profiles: {
      local: {
        agent: 'build',
        provider: 'ollama',
        model: 'gpt-oss:20b',
        runtimeSeconds: 120,
        maxToolCalls: 16,
        maxRepairs: 0,
      },
    },
    allowedOverrides: [],
  };
  const report: {
    complete: boolean;
    environments: unknown[];
    manual: string;
    diffs: string[];
    failureChecks: string[];
    error?: string;
  } = {
    complete: false,
    environments: [],
    diffs: [],
    failureChecks: [],
    manual: options.retainGateways
      ? 'Open both printed worktree paths in host VS Code and a devcontainer with identical absolute mounts; verify editing/diff. This is not automated.'
      : 'Guest evidence only. Actual Ubuntu/VS Code path editing and deployment enforcement remain separate host acceptance.',
  };
  try {
    for (const number of [1, 2]) {
      const modelGateway = join(root, `model${number}`);
      const gateway = spawn(
        'python3',
        ['runtime/environment/model_gateway.py', modelGateway, 'gpt-oss:20b'],
        { stdio: 'ignore', detached: options.retainGateways },
      );
      gateways.push(gateway);
      let startupFailed = false;
      gateway.on('error', () => {
        startupFailed = true;
      });
      if (options.retainGateways) gateway.unref();
      const until = Date.now() + 5000;
      while (!existsSync(join(root, `model${number}.gateway.json`))) {
        if (startupFailed || gateway.exitCode !== null || Date.now() > until)
          throw new Error('Supervisor model gateway did not start');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const issue: IssueSnapshot = {
        repository: project.repository,
        number,
        url: `https://github.com/synthetic/fixture/issues/${number}`,
        title: 'Explicit synthetic integration fixture',
        body: 'Synthetic verification, not a GitHub issue admission',
        state: 'open',
        labels: [],
        comments: [],
        milestone: null,
        blockers: [],
        dependenciesVerified: true,
        dependencyLimitation: null,
        fetchedAt: new Date().toISOString(),
      };
      const task = store.enqueue(
        issue,
        project,
        'Operator explicitly invoked disposable integration verification',
      );
      const manager = new EnvironmentManager(store, db);
      const env = manager.prepare(task.id, issue, {
        source,
        shared: join(root, 'shared'),
        modelGateway,
        workerImage: reviewedImages.worker,
        databaseImage: reviewedImages.database,
      });
      if ('blocked' in env) throw new Error('Synthetic task blocked');
      assert.equal(env.status, 'ready');
      assert.equal(git('-C', source, 'status', '--porcelain'), original);
      assert.equal(
        readFileSync(join(source, 'fixture.txt'), 'utf8'),
        'uncommitted source edits\n',
      );
      assert.equal(
        readFileSync(join(root, 'shared/attachment.txt'), 'utf8'),
        'synthetic attachment\n',
      );
      writeFileSync(join(env.worktree, 'fixture.txt'), `task ${number} only\n`);
      assert.ok(
        git('-C', env.worktree, 'diff').includes(`+task ${number} only`),
      );
      report.environments.push(env);
      report.diffs.push(git('-C', env.worktree, 'diff'));
      store.close();
      store = new QueueStore(db);
      assert.deepEqual(store.environment(task.id), env);
      new EnvironmentManager(store, db).check(env);
      if (options.verifyFailures) {
        const manifest = join(root, `model${number}.gateway.json`);
        const originalManifest = readFileSync(manifest, 'utf8');
        try {
          const changed = JSON.parse(originalManifest) as { model: string };
          changed.model = 'forbidden';
          writeFileSync(manifest, JSON.stringify(changed));
          assert.throws(() => new EnvironmentManager(store, db).check(env));
        } finally {
          writeFileSync(manifest, originalManifest);
        }
        assert.equal(
          new DockerRuntime().gatewayIdentity(env.config, env.model),
          env.gatewayIdentity,
        );
        report.failureChecks.push(`gateway-substitution-denied:${number}`);
      }
      console.log(
        JSON.stringify({
          taskId: task.id,
          worktree: env.worktree,
          ready: true,
        }),
      );
    }
    const environments = store.list().map((t) => store.environment(t.id)!);
    assert.notEqual(
      environments[0]!.resources.databaseId,
      environments[1]!.resources.databaseId,
    );
    assert.notEqual(environments[0]!.root, environments[1]!.root);
    report.complete = true;
  } catch (error) {
    report.error =
      error instanceof Error ? error.message : 'Integration failed';
  } finally {
    store.close();
    if (!options.retainGateways) {
      for (const gateway of gateways) {
        try {
          if (
            gateway.exitCode !== null ||
            gateway.signalCode !== null ||
            !gateway.pid
          )
            continue;
          const exited = once(gateway, 'exit', {
            signal: AbortSignal.timeout(3000),
          });
          gateway.kill('SIGTERM');
          try {
            await exited;
          } catch {
            const killed = once(gateway, 'exit', {
              signal: AbortSignal.timeout(3000),
            });
            gateway.kill('SIGKILL');
            await killed;
          }
        } catch {
          report.complete = false;
          report.error = 'Fixture gateway termination unverified';
        }
      }
    }
    writeFileSync(
      options.reportPath ?? join(root, 'report.json'),
      JSON.stringify(report, null, 2),
      {
        mode: 0o600,
      },
    );
    console.log(
      'Fixture resources retained by the manager; outer disposable VM owns guest teardown.',
    );
  }

  return { root, ...report };
}
