import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request, type Server } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import {
  ExecutionController,
  SessionEvents,
  type ExecutionRecord,
} from '../src/execution/controller.js';
import { ExecutionGateway, toolCalls } from '../src/execution/gateway.js';
import { ExecutionRuntime } from '../src/execution/runtime.js';
import { capture, type ProcessResult } from '../src/execution/process.js';
import { EnvironmentManager } from '../src/environment/manager.js';
import { DockerRuntime } from '../src/environment/runtime.js';
import type { Environment } from '../src/environment/types.js';
import type { Project } from '../src/queue/config.js';
import type { IssueSnapshot } from '../src/queue/github.js';
import { QueueStore } from '../src/queue/store.js';
import { validateProfile } from '../src/queue/config.js';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];
const stores: QueueStore[] = [];
const servers: Server[] = [];
const root = () => {
  const path = mkdtempSync(join(tmpdir(), 'cf-exec-test-'));
  roots.push(path);
  return path;
};
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  stores.splice(0).forEach((store) => store.close());
  roots
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true }));
});
const issue: IssueSnapshot = {
  repository: 'synthetic/task',
  number: 1,
  url: 'https://github.com/synthetic/task/issues/1',
  title: 'Approved fixture',
  body: 'Implement clamp',
  state: 'open',
  labels: [],
  comments: [],
  milestone: null,
  blockers: [],
  dependenciesVerified: true,
  dependencyLimitation: null,
  fetchedAt: new Date().toISOString(),
};
function fixture() {
  const directory = root();
  const path = join(directory, 'private/state.sqlite');
  const store = new QueueStore(path);
  stores.push(store);
  const project: Project = {
    repository: issue.repository,
    taskRoot: directory,
    validation: [
      ['node', '--test'],
      ['node', '--check', 'clamp.mjs'],
    ],
    serviceRefs: {},
    defaultProfile: 'local',
    profiles: {
      local: {
        agent: 'build',
        provider: 'ollama',
        model: 'gpt-oss:20b',
        runtimeSeconds: 60,
        maxToolCalls: 16,
        maxRepairs: 2,
      },
    },
    allowedOverrides: [],
  };
  const task = store.enqueue(issue, project, 'Explicit deterministic fixture');
  const claim = store.claim(task.id, issue);
  if ('blocked' in claim) throw new Error('Unexpected block');
  const environment: Environment = {
    taskId: task.id,
    attemptId: claim.attemptId,
    owner: 'fixture-owner',
    status: 'preparing',
    stage: 'test',
    error: null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    root: directory,
    worktree: join(directory, 'worktree'),
    branch: 'fixture',
    base: 'a'.repeat(40),
    config: {
      source: directory,
      shared: directory,
      modelGateway: directory,
      workerImage: '',
      databaseImage: '',
    },
    profileHash: '',
    model: task.profile.model,
    resources: { databaseName: '', workerName: '', volumeName: '' },
    ports: { application: 3000, postgres: 6432, model: 4111 },
  };
  store.reserveEnvironment(environment, claim.token);
  environment.status = 'ready';
  store.saveEnvironment(environment, claim.token);
  class Manager extends EnvironmentManager {
    fail = false;
    override check(environment: Environment): {
      ready: true;
      worktree: string;
    } {
      if (this.fail) throw new Error('Boundary missing');
      return { ready: true, worktree: environment.worktree };
    }
  }
  const manager = new Manager(store, path);
  return { directory, path, store, task, manager, environment };
}
const successful: ProcessResult = {
  exit: 0,
  signal: null,
  limited: false,
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
};
class Runtime extends ExecutionRuntime {
  calls: Record<string, unknown>[] = [];
  modelDirectories: string[] = [];
  failures = 0;
  stopUncertain = false;
  disposition = 'candidate';
  summaryPrefix = '';
  diagnostic = 'recoverable assertion failure';
  diagnostics: string[] = [];
  validationExit = 1;
  denyModelDuringValidation = false;
  override async run(
    ...args: Parameters<ExecutionRuntime['run']>
  ): Promise<ProcessResult> {
    const [, , , settings, prefix, , reserved, onLine] = args;
    this.calls.push(settings);
    this.modelDirectories.push(args[0].config.modelGateway);
    reserved(String(this.calls.length).padStart(64, '0'));
    if (this.stopUncertain) throw new Error('Termination unverified');
    writeFileSync(
      `${prefix}.stdout`,
      settings.mode === 'validation'
        ? (this.diagnostics.shift() ?? this.diagnostic)
        : this.diagnostic,
    );
    writeFileSync(`${prefix}.stderr`, '');
    if (settings.mode === 'evidence') return successful;
    if (settings.mode === 'validation' && this.denyModelDuringValidation)
      await post(join(args[0].config.modelGateway, 'ollama.sock'));
    if (settings.mode === 'coding') {
      onLine?.(
        JSON.stringify({ type: 'step_start', sessionID: 'ses_fixture' }),
      );
      onLine?.(
        JSON.stringify({
          type: 'text',
          sessionID: 'ses_fixture',
          part: { text: `${this.summaryPrefix}CF_RESULT: ${this.disposition}` },
        }),
      );
      onLine?.(
        JSON.stringify({
          type: 'step_finish',
          sessionID: 'ses_fixture',
          part: { reason: 'stop' },
        }),
      );
      return successful;
    }
    return {
      ...successful,
      exit: this.failures-- > 0 ? this.validationExit : 0,
    };
  }
}
it('retains a native session and individual validations; continues only the explicit session for bounded repair', async () => {
  const { store, manager, task, environment } = fixture();
  const runtime = new Runtime();
  runtime.failures = 1;
  await new ExecutionController(store, manager, runtime).execute(
    task.id,
    issue,
  );
  expect(store.get(task.id).status).toBe('candidate-ready');
  expect(
    runtime.calls
      .filter((value) => value.mode === 'coding')
      .map((value) => value.session),
  ).toEqual([null, 'ses_fixture']);
  const attempts = store.attempts(task.id) as { id: string }[];
  const execution = store.execution(attempts[1]!.id) as ExecutionRecord;
  expect(execution.rounds.map((value) => value.validation.length)).toEqual([
    2, 2,
  ]);
  expect(execution.rounds[0]!.validation[0]!.result.exit).toBe(1);
  expect(execution.unresolved[0]).toContain('independent review');
  expect(
    runtime.calls
      .filter((value) => value.mode === 'coding')
      .map((value) => value.title),
  ).toEqual([
    `Code Foundry ${task.repository}#${task.number} / ${execution.attemptId}`,
    `Code Foundry ${task.repository}#${task.number} / ${execution.attemptId}`,
  ]);
  expect(new Set(runtime.modelDirectories).size).toBe(1);
  expect(runtime.modelDirectories[0]).not.toBe(environment.config.modelGateway);
});
it('validates the candidate after an inline terminal disposition from the real host response', async () => {
  const { store, manager, task } = fixture();
  const runtime = new Runtime();
  runtime.summaryPrefix = 'Implemented clamp with min/max logic. ';
  await new ExecutionController(store, manager, runtime).execute(
    task.id,
    issue,
  );
  expect(store.get(task.id).status).toBe('candidate-ready');
  const attempts = store.attempts(task.id) as { id: string }[];
  const execution = store.execution(attempts.at(-1)!.id) as ExecutionRecord;
  expect(
    execution.rounds[0]!.validation.map((value) => value.result.exit),
  ).toEqual([0, 0]);
  expect(execution.unresolved[0]).toContain('independent review');
});
it('uses only the terminal unquoted disposition of the final native step', () => {
  const events = new SessionEvents('ses_fixture');
  const text = (value: string) =>
    events.accept(
      JSON.stringify({
        type: 'text',
        sessionID: 'ses_fixture',
        part: { text: value },
      }),
    );
  text('Implemented clamp with min/max logic. CF_RESULT: candidate');
  expect(events.disposition).toBe('candidate');
  for (const value of [
    'CF_RESULT: candidate is an example.',
    '"CF_RESULT: candidate"',
    'CF_RESULT: candidate\nMore unresolved work.',
    'CF_RESULT: candidate-ready',
  ]) {
    text(value);
    expect(events.disposition).toBeNull();
  }
  text('CF_RESULT: candidate');
  events.accept(
    JSON.stringify({ type: 'step_start', sessionID: 'ses_fixture' }),
  );
  expect(events.disposition).toBeNull();
  text('An architectural decision is required. CF_RESULT: blocked');
  expect(events.disposition).toBe('blocked');
  text('Validation remains unresolved. CF_RESULT: needs-local-repair');
  expect(events.disposition).toBe('needs-local-repair');
});
it('isolates trusted Python startup from worktree modules and user site hooks', async () => {
  const { directory, environment } = fixture();
  mkdirSync(join(directory, 'worktree'));
  const home = join(directory, 'home');
  mkdirSync(home);
  writeFileSync(
    join(directory, 'database.json'),
    JSON.stringify({
      user: 'synthetic',
      password: 'invented',
      database: 'synthetic',
    }),
  );
  const marker = join(directory, 'untrusted-import');
  const malicious = `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('untrusted')\nraise RuntimeError('Untrusted import ran')\n`;
  writeFileSync(join(directory, 'worktree/socket.py'), malicious);
  const site = spawnSync(
    'python3',
    ['-I', '-c', 'import site; print(site.getusersitepackages())'],
    { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' },
  );
  expect(site.status).toBe(0);
  expect(site.stdout.trim().startsWith(home + '/')).toBe(true);
  mkdirSync(site.stdout.trim(), { recursive: true });
  writeFileSync(join(site.stdout.trim(), 'usercustomize.py'), malicious);
  let created: string[] = [];
  const docker = new DockerRuntime((_program, args) => {
    created = args;
    throw new Error('Captured create without Docker');
  });
  await expect(
    new ExecutionRuntime(docker).run(
      environment,
      directory,
      'fixture',
      {
        mode: 'evidence',
        command: [process.execPath, '-e', 'console.log("isolated wrapper")'],
      },
      join(directory, 'capture'),
      Date.now() + 5000,
      () => {},
    ),
  ).rejects.toThrow('Captured create');
  const result = spawnSync(
    'python3',
    created.slice(created.indexOf('python3') + 1),
    {
      cwd: join(directory, 'worktree'),
      env: { PATH: process.env.PATH, HOME: home },
      encoding: 'utf8',
      timeout: 5000,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('isolated wrapper');
  expect(() => readFileSync(marker)).toThrow();
  expect(() =>
    docker.probe(environment, directory, environment.model, () => {}),
  ).toThrow('Captured create');
  const probeArgs = created.slice(created.indexOf('--entrypoint') + 3);
  const scriptIndex = probeArgs.indexOf('-c') + 1;
  const script = probeArgs[scriptIndex]!;
  const firstCheck = script.indexOf("check('nonRoot'");
  expect(firstCheck).toBeGreaterThan(0);
  // Exercise the actual probe startup/import configuration without running
  // container-only security checks against the development environment.
  probeArgs[scriptIndex] =
    script.slice(0, firstCheck) + '\nprint("isolated probe imports")\n';
  const probe = spawnSync('python3', probeArgs, {
    cwd: environment.worktree,
    env: { PATH: process.env.PATH, HOME: home },
    encoding: 'utf8',
    timeout: 5000,
  });
  expect(probe.status, probe.stderr).toBe(0);
  expect(probe.stdout).toContain('isolated probe imports');
  expect(() => readFileSync(marker)).toThrow();
});
it('repeated validation failures stop further automatic repairs', async () => {
  const { store, manager, task } = fixture();
  const runtime = new Runtime();
  runtime.failures = 100;
  await new ExecutionController(store, manager, runtime).execute(
    task.id,
    issue,
  );
  expect(store.get(task.id).status).toBe('needs-local-repair');
  expect(runtime.calls.filter((value) => value.mode === 'coding')).toHaveLength(
    2,
  );
});
it('fails closed before launch on readiness or changed specification', async () => {
  const { store, manager, task } = fixture();
  const runtime = new Runtime();
  manager.fail = true;
  await new ExecutionController(store, manager, runtime).execute(task.id, {
    ...issue,
    body: 'Unapproved change',
  });
  expect(store.get(task.id).status).toBe('blocked');
  expect(runtime.calls).toHaveLength(0);
  await new ExecutionController(store, manager, runtime).execute(
    task.id,
    issue,
  );
  expect(store.get(task.id).status).toBe('blocked');
  expect(runtime.calls).toHaveLength(0);
});
it('retains uncertain execution across reopen and refuses replay, competing claims and manual release', async () => {
  const { store, manager, task, path } = fixture();
  const runtime = new Runtime();
  runtime.stopUncertain = true;
  await expect(
    new ExecutionController(store, manager, runtime).execute(task.id, issue),
  ).rejects.toThrow('termination');
  const reopened = new QueueStore(path);
  stores.push(reopened);
  const attempts = reopened.attempts(task.id) as { id: string }[];
  expect(
    (reopened.execution(attempts[1]!.id) as ExecutionRecord).containers,
  ).toHaveLength(1);
  await expect(
    new ExecutionController(reopened, manager, runtime).execute(task.id, issue),
  ).rejects.toThrow('not claimable');
  const other = reopened.enqueue(
    { ...issue, number: 2 },
    task.project,
    'Explicit fixture',
  );
  expect(() => reopened.claim(other.id, { ...issue, number: 2 })).toThrow(
    'active',
  );
  expect(() =>
    reopened.transition(task.id, 'failed', 'Manual release'),
  ).toThrow('verified termination');
});
it('reported ambiguity blocks validation and repair even after a complete exit-zero session', async () => {
  const { store, manager, task } = fixture();
  const runtime = new Runtime();
  runtime.disposition = 'blocked';
  await new ExecutionController(store, manager, runtime).execute(
    task.id,
    issue,
  );
  expect(store.get(task.id).status).toBe('blocked');
  expect(runtime.calls.filter((value) => value.mode === 'coding')).toHaveLength(
    1,
  );
});
it('does not repair infrastructure exits or unrecognized failures', async () => {
  for (const [exit, diagnostic, outcome] of [
    [125, 'missing command', 'failed'],
    [1, 'unknown service problem', 'needs-local-repair'],
    [1, 'AssertionError: permission denied', 'needs-local-repair'],
  ] as const) {
    const { store, manager, task } = fixture();
    const runtime = new Runtime();
    runtime.failures = 1;
    runtime.validationExit = exit;
    runtime.diagnostic = diagnostic;
    await new ExecutionController(store, manager, runtime).execute(
      task.id,
      issue,
    );
    expect(store.get(task.id).status).toBe(outcome);
    expect(
      runtime.calls.filter((value) => value.mode === 'coding'),
    ).toHaveLength(1);
  }
});
it('requires every failed validation to be recoverable before requesting repair', async () => {
  const { store, manager, task } = fixture();
  const runtime = new Runtime();
  runtime.failures = 2;
  runtime.diagnostics = [
    'AssertionError: fixture mismatch',
    'service temporarily unavailable',
  ];
  await new ExecutionController(store, manager, runtime).execute(
    task.id,
    issue,
  );
  expect(store.get(task.id).status).toBe('needs-local-repair');
  expect(runtime.calls.filter((value) => value.mode === 'coding')).toHaveLength(
    1,
  );
});
it('blocks validation model denials even when the validation command exits zero, and persists its counters', async () => {
  const { store, manager, task } = fixture();
  const runtime = new Runtime();
  runtime.denyModelDuringValidation = true;
  await new ExecutionController(store, manager, runtime).execute(
    task.id,
    issue,
  );
  expect(store.get(task.id).status).toBe('blocked');
  const attempts = store.attempts(task.id) as { id: string }[];
  const execution = store.execution(attempts.at(-1)!.id) as ExecutionRecord;
  expect(execution.requests).toBe(1);
  expect(execution.modelDenial?.reason).toBe('upstream-transport');
  expect(execution.rounds[0]!.validation).toHaveLength(1);
  expect(execution.rounds[0]!.validation[0]!.result.exit).toBe(0);
});
it('migrates B2 state without replacing approvals or prepared ownership', () => {
  const { store, path, task, environment } = fixture();
  const prior = store.get(task.id);
  const sqlite = new DatabaseSync(path);
  sqlite.exec('DROP TABLE executions; PRAGMA user_version=2;');
  sqlite.close();
  const upgraded = new QueueStore(path);
  stores.push(upgraded);
  expect(upgraded.get(task.id)).toEqual(prior);
  expect(upgraded.environment(task.id)).toEqual(environment);
  expect(upgraded.execution('missing')).toBeNull();
});
it('validates bounded profile paths and rejects excessive execution budgets', () => {
  const profile = fixture().task.profile;
  expect(
    validateProfile({
      ...profile,
      instructions: ['AGENTS.md'],
      skills: ['.agents/skills'],
    }).skills,
  ).toEqual(['.agents/skills']);
  for (const extra of [
    { instructions: ['../secret'] },
    { skills: ['/private'] },
    { runtimeSeconds: 3601 },
    { maxToolCalls: 1001 },
    { maxRepairs: 4 },
  ])
    expect(() => validateProfile({ ...profile, ...extra })).toThrow();
});
it('rejects missing completion, invalid events and changing session identities', () => {
  const events = new SessionEvents();
  events.accept(JSON.stringify({ type: 'step_start', sessionID: 'ses_a' }));
  expect(events.complete).toBe(false);
  expect(() =>
    events.accept(JSON.stringify({ type: 'text', sessionID: 'ses_b' })),
  ).toThrow('identity');
  expect(() => events.accept('not json')).toThrow();
  events.accept(JSON.stringify({ type: 'error' }));
  expect(events.error).toBe(true);
});
const response = (count: number) =>
  JSON.stringify({
    choices: [
      {
        message: {
          tool_calls: Array.from({ length: count }, (_, index) => ({
            id: `call_${index}`,
            type: 'function',
            function: { name: 'read', arguments: '{}' },
          })),
        },
        finish_reason: count ? 'tool_calls' : 'stop',
      },
    ],
  });
it('buffers SSE until complete and counts parallel tool calls once across argument deltas', () => {
  const raw =
    [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_a' },
                { index: 1, id: 'call_b' },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0 }] },
            finish_reason: 'tool_calls',
          },
        ],
      },
    ]
      .map((value) => `data: ${JSON.stringify(value)}\n\n`)
      .join('') + 'data: [DONE]\n\n';
  expect(toolCalls(raw, 'text/event-stream')).toBe(2);
  expect(() =>
    toolCalls(
      raw.replace(
        '"tool_calls":[{"index":0}]',
        '"tool_calls":[{"index":0,"id":"changed"}]',
      ),
      'text/event-stream',
    ),
  ).toThrow('identity changed');
  expect(() =>
    toolCalls(raw.replace('data: [DONE]', ''), 'text/event-stream'),
  ).toThrow('Incomplete');
  expect(() => toolCalls('{broken', 'application/json')).toThrow();
  expect(() =>
    toolCalls(
      JSON.stringify({
        choices: [
          { message: { tool_calls: 'malformed' }, finish_reason: 'tool_calls' },
        ],
      }),
      'application/json',
    ),
  ).toThrow('Malformed');
});
function post(socketPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const connection = request(
      { socketPath, method: 'POST', path: '/v1/chat/completions' },
      (result) => {
        let body = '';
        result.on('data', (data: Buffer) => (body += data.toString()));
        result.on('end', () => resolve({ status: result.statusCode!, body }));
      },
    );
    connection.on('error', reject);
    connection.end('{}');
  });
}
it('enforces the remaining parallel-call budget before any response reaches the client', async () => {
  const directory = root();
  let upstreamRequests = 0;
  const upstream = createServer((_request, result) => {
    upstreamRequests++;
    result
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(response(2));
  });
  servers.push(upstream);
  await new Promise<void>((resolve) =>
    upstream.listen(join(directory, 'upstream.sock'), resolve),
  );
  const gateway = new ExecutionGateway(
    join(directory, 'upstream.sock'),
    3,
    Date.now() + 10000,
  );
  await gateway.listen(join(directory, 'budget.sock'));
  try {
    expect((await post(join(directory, 'budget.sock'))).status).toBe(200);
    const denied = await post(join(directory, 'budget.sock'));
    expect(denied.status).toBe(403);
    expect(denied.body).not.toContain('tool_calls');
    expect(gateway.tools).toBe(2);
    expect(gateway.denied).toBe(true);
    expect(gateway.denial?.reason).toBe('tool-budget');
    expect(upstreamRequests).toBe(2);
    expect((await post(join(directory, 'budget.sock'))).status).toBe(403);
    expect(upstreamRequests).toBe(2);
  } finally {
    await gateway.close();
  }
});
it('refuses concurrent inference before forwarding and retains the first nonsecret denial reason', async () => {
  const directory = root();
  let arrived!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let upstreamRequests = 0;
  const upstream = createServer(async (_incoming, outgoing) => {
    upstreamRequests++;
    arrived();
    await held;
    outgoing
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(response(1));
  });
  servers.push(upstream);
  await new Promise<void>((resolve) =>
    upstream.listen(join(directory, 'upstream.sock'), resolve),
  );
  const gateway = new ExecutionGateway(
    join(directory, 'upstream.sock'),
    16,
    Date.now() + 10000,
  );
  await gateway.listen(join(directory, 'budget.sock'));
  const first = post(join(directory, 'budget.sock'));
  try {
    await started;
    const second = await post(join(directory, 'budget.sock'));
    expect(second.status).toBe(403);
    expect(gateway.denial).toEqual({ reason: 'concurrent-request' });
    release();
    expect((await first).status).toBe(403);
    expect(gateway.tools).toBe(0);
    expect(gateway.requests).toBe(1);
    expect(upstreamRequests).toBe(1);
  } finally {
    release();
    await first;
    await gateway.close();
  }
});
it('records upstream status without forwarding its private response body', async () => {
  const directory = root();
  const upstream = createServer((_incoming, outgoing) =>
    outgoing.writeHead(400).end('private-fixture-response-never-forward'),
  );
  servers.push(upstream);
  await new Promise<void>((resolve) =>
    upstream.listen(join(directory, 'upstream.sock'), resolve),
  );
  const gateway = new ExecutionGateway(
    join(directory, 'upstream.sock'),
    16,
    Date.now() + 10000,
  );
  await gateway.listen(join(directory, 'budget.sock'));
  try {
    const result = await post(join(directory, 'budget.sock'));
    expect(result.status).toBe(403);
    expect(result.body).not.toContain('private-fixture-response-never-forward');
    expect(gateway.denial).toEqual({
      reason: 'upstream-status',
      upstreamStatus: 400,
    });
  } finally {
    await gateway.close();
  }
});
it('bounds process output and runtime while retaining private logs', async () => {
  const directory = root();
  const result = await capture(
    process.execPath,
    ['-e', 'setInterval(()=>console.log("waiting"),10)'],
    join(directory, 'timeout'),
    Date.now() + 150,
  );
  expect(result.limited).toBe(true);
  expect(result.signal).toBe('SIGKILL');
  expect(readFileSync(join(directory, 'timeout.stdout'), 'utf8')).toContain(
    'waiting',
  );
  mkdirSync(join(directory, 'logs'));
  const overflow = await capture(
    process.execPath,
    ['-e', 'process.stdout.write("x".repeat(3000000))'],
    join(directory, 'logs/overflow'),
    Date.now() + 5000,
  );
  expect(overflow.limited).toBe(true);
});
