import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readProject, resolveProfile } from '../src/queue/config.js';
import type { Project } from '../src/queue/config.js';
import { fetchIssue, parseIssue } from '../src/queue/github.js';
import type { IssueSnapshot, Request } from '../src/queue/github.js';
import { QueueStore } from '../src/queue/store.js';

const roots: string[] = [];
const stores: QueueStore[] = [];
const root = () => {
  const path = mkdtempSync(join(tmpdir(), 'code-foundry-queue-test-'));
  roots.push(path);
  return path;
};
const open = (path: string) => {
  const store = new QueueStore(path);
  stores.push(store);
  return store;
};
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const path of roots.splice(0))
    rmSync(path, { recursive: true, force: true });
});
const project: Project = {
  repository: 'fixture/project',
  taskRoot: '/tmp/fixture-tasks',
  validation: [['node', '--test']],
  serviceRefs: { database: 'fixture-postgres' },
  defaultProfile: 'local',
  profiles: {
    local: {
      agent: 'build',
      provider: 'ollama',
      model: 'gpt-oss:20b',
      runtimeSeconds: 120,
      maxToolCalls: 30,
      maxRepairs: 1,
    },
  },
  allowedOverrides: ['runtimeSeconds'],
};
const issue = (number = 1): IssueSnapshot => ({
  repository: project.repository,
  number,
  url: `https://github.com/fixture/project/issues/${number}`,
  title: 'Fixture',
  body: 'Implement the fixture',
  state: 'open',
  labels: ['approved'],
  comments: [],
  milestone: null,
  blockers: [],
  dependenciesVerified: true,
  dependencyLimitation: null,
  fetchedAt: new Date().toISOString(),
});
const githubIssue = (overrides: Record<string, unknown> = {}) => ({
  number: 1,
  title: 'Fixture',
  body: '',
  state: 'open',
  labels: [{ name: 'approved' }],
  milestone: null,
  ...overrides,
});
function request(overrides: Record<string, unknown> = {}): Request {
  const data: Record<string, unknown> = {
    'repos/fixture/project': { permissions: { pull: true } },
    'repos/fixture/project/issues/1': githubIssue(),
    'repos/fixture/project/issues/1/comments?per_page=100&page=1': [],
    'repos/fixture/project/issues/1/dependencies/blocked_by?per_page=100&page=1':
      [],
    ...overrides,
  };
  return (endpoint) => {
    if (!Object.hasOwn(data, endpoint))
      throw new Error('Unavailable fixture route');
    return data[endpoint];
  };
}

describe('project configuration and GitHub intake', () => {
  it('resolves approved profiles and rejects secret fields, URLs and disallowed overrides', () => {
    expect(
      resolveProfile(project, undefined, { runtimeSeconds: 60 }).runtimeSeconds,
    ).toBe(60);
    expect(() =>
      resolveProfile(project, undefined, { model: 'other' }),
    ).toThrow('not permitted');
    expect(() => resolveProfile(project, 'missing')).toThrow('Unknown');
    expect(() =>
      resolveProfile(project, undefined, { runtimeSeconds: NaN }),
    ).toThrow('limits');
    const path = join(root(), 'project.json');
    writeFileSync(path, '{synthetic-secret');
    expect(() => readProject(path)).toThrow(
      'Project configuration is not valid JSON',
    );
    writeFileSync(path, JSON.stringify(project));
    expect(readProject(path)).toEqual(project);
    writeFileSync(
      path,
      JSON.stringify({ ...project, token: 'synthetic-secret' }),
    );
    expect(() => readProject(path)).toThrow('Unsupported');
    writeFileSync(
      path,
      JSON.stringify({
        ...project,
        serviceRefs: { db: 'postgres://user:synthetic-secret@host/db' },
      }),
    );
    expect(() => readProject(path)).toThrow();
    writeFileSync(
      path,
      JSON.stringify({ ...project, validation: ['node --test'] }),
    );
    expect(() => readProject(path)).toThrow('argument arrays');
  });
  it('restricts references to the configured repository', () => {
    for (const input of [
      '1',
      'fixture/project#1',
      'https://github.com/fixture/project/issues/1',
    ])
      expect(parseIssue(input, project.repository)).toEqual({
        repository: project.repository,
        number: 1,
      });
    for (const input of [
      '0',
      '-1',
      '99999999999999999999999',
      'https://evil.invalid/fixture/project/issues/1',
      'other/project#1',
      'https://github.com/fixture/project/pull/1',
    ])
      expect(() => parseIssue(input, project.repository)).toThrow();
  });
  it('captures comments, labels, milestone and both native and body dependencies', () => {
    const value = fetchIssue(
      { repository: project.repository, number: 1 },
      request({
        'repos/fixture/project/issues/1': githubIssue({
          body: '## Blocked by\n- https://github.com/fixture/project/issues/3\n\n## Other\nIgnore this',
          milestone: { number: 2, title: 'B' },
        }),
        'repos/fixture/project/issues/1/comments?per_page=100&page=1': [
          { user: { login: 'reviewer' }, body: 'approved' },
        ],
        'repos/fixture/project/issues/1/dependencies/blocked_by?per_page=100&page=1':
          [
            {
              number: 2,
              html_url: 'https://github.com/fixture/project/issues/2',
              state: 'open',
            },
          ],
        'repos/fixture/project/issues/3': githubIssue({
          number: 3,
          state: 'closed',
        }),
      }),
    );
    expect(value.dependenciesVerified).toBe(true);
    expect(value.blockers.map((b) => [b.number, b.state])).toEqual([
      [2, 'open'],
      [3, 'closed'],
    ]);
    expect(value.comments).toEqual([{ author: 'reviewer', body: 'approved' }]);
    expect(value.milestone?.title).toBe('B');
    expect(value.labels).toEqual(['approved']);
  });
  it('blocks when dependency access is unavailable, ambiguous or outside the configured repository', () => {
    const unavailable: Request = (endpoint) => {
      if (endpoint.includes('/dependencies/'))
        throw new Error('HTTP 403 secret');
      return request()(endpoint);
    };
    expect(
      fetchIssue({ repository: project.repository, number: 1 }, unavailable)
        .dependenciesVerified,
    ).toBe(false);
    for (const body of [
      '## Blocked by\n- #2',
      '## Blocked by\n- https://github.com/other/repo/issues/2',
    ]) {
      expect(
        fetchIssue(
          { repository: project.repository, number: 1 },
          request({ 'repos/fixture/project/issues/1': githubIssue({ body }) }),
        ).dependenciesVerified,
      ).toBe(false);
    }
    expect(() =>
      fetchIssue(
        { repository: project.repository, number: 1 },
        request({ 'repos/fixture/project': { permissions: { pull: false } } }),
      ),
    ).toThrow('permission');
    expect(() =>
      fetchIssue(
        { repository: project.repository, number: 1 },
        request({
          'repos/fixture/project/issues/1': githubIssue({ pull_request: {} }),
        }),
      ),
    ).toThrow('pull request');
  });
  it('paginates structured comments instead of truncating approval context', () => {
    const page = Array.from({ length: 100 }, () => ({
      user: { login: 'fixture' },
      body: 'comment',
    }));
    const value = fetchIssue(
      { repository: project.repository, number: 1 },
      request({
        'repos/fixture/project/issues/1/comments?per_page=100&page=1': page,
        'repos/fixture/project/issues/1/comments?per_page=100&page=2': [
          { user: { login: 'last' }, body: 'last' },
        ],
      }),
    );
    expect(value.comments).toHaveLength(101);
  });
});

describe('durable approved queue', () => {
  it('refuses dangling symlinks for database and SQLite sidecar files', () => {
    for (const suffix of ['', '-wal', '-shm']) {
      const dir = root();
      const path = join(dir, 'state.sqlite');
      symlinkSync(join(dir, 'absent-target'), path + suffix);
      expect(() => new QueueStore(path)).toThrow('regular private files');
    }
  });
  it('keeps admission idempotent, persists restart state and records approval history', () => {
    const path = join(root(), 'state.sqlite');
    const store = open(path);
    expect(() => store.enqueue(issue(), project, '')).toThrow('approval');
    const task = store.enqueue(issue(), project, 'user request');
    expect(store.enqueue(issue(), project, 'same request').id).toBe(task.id);
    expect(store.events(task.id)).toHaveLength(1);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const restarted = open(path);
    expect(restarted.get(task.id)).toEqual(task);
    const updated = { ...issue(), body: 'New requirement' };
    restarted.enqueue(updated, project, 'new approval');
    expect(store.get(task.id).issue.body).toBe('New requirement');
    expect(store.events(task.id)).toHaveLength(2);
  });
  it('blocks unresolved dependencies, rechecks at claim and requires approval for specification drift', () => {
    const store = open(join(root(), 'state.sqlite'));
    const snapshot = {
      ...issue(),
      blockers: [{ repository: project.repository, number: 2, state: 'open' }],
    };
    const task = store.enqueue(snapshot, project, 'user');
    expect(task.status).toBe('blocked');
    expect(store.claim(task.id, snapshot)).toHaveProperty('blocked', true);
    const cleared = {
      ...snapshot,
      blockers: [
        { repository: project.repository, number: 2, state: 'closed' },
      ],
    };
    expect(
      store.claim(task.id, { ...cleared, body: 'different' }),
    ).toHaveProperty('blocked', true);
    expect(store.get(task.id).reason).toContain('specification changed');
    const claim = store.claim(task.id, cleared);
    expect(claim).toHaveProperty('attemptId');
    expect(store.attempts(task.id)).toHaveLength(1);
    expect(() => store.claim(task.id, cleared)).toThrow('not claimable');
  });
  it('fails closed for unverifiable dependency data and closed issues', () => {
    const store = open(join(root(), 'state.sqlite'));
    expect(
      store.enqueue(
        { ...issue(), dependenciesVerified: false },
        project,
        'user',
      ).status,
    ).toBe('blocked');
    expect(
      store.enqueue({ ...issue(2), state: 'closed' }, project, 'user').status,
    ).toBe('blocked');
  });
  it('protects ownership and transitions, snapshots attempts and retains active claims across restart', () => {
    const path = join(root(), 'state.sqlite');
    const store = open(path);
    const task = store.enqueue(issue(), project, 'user', 'local', {
      runtimeSeconds: 60,
    });
    const claim = store.claim(task.id, issue());
    if (!('token' in claim)) throw new Error('Expected claim');
    const second = store.enqueue(issue(2), project, 'user');
    const restarted = open(path);
    expect(() => restarted.claim(second.id, issue(2))).toThrow(
      'already active',
    );
    expect(() => store.transition(task.id, 'queued', 'unsafe')).toThrow(
      'Invalid',
    );
    expect(() => store.transition(task.id, 'failed', 'not owner')).toThrow(
      'ownership',
    );
    expect(() =>
      store.transition(task.id, 'blocked', 'not owner', {
        attemptId: claim.attemptId,
        token: 'wrong',
      }),
    ).toThrow('ownership');
    expect(
      store.transition(
        task.id,
        'blocked',
        'Mock process reconciled; no process was launched',
        claim,
      ).status,
    ).toBe('blocked');
    expect(() => store.transition(task.id, 'running', 'bypass')).toThrow(
      'Invalid',
    );
    expect(restarted.claim(second.id, issue(2))).toHaveProperty('attemptId');
    expect(JSON.stringify(store.attempts(task.id))).toContain(
      '"runtimeSeconds":60',
    );
    expect(JSON.stringify(store.events(task.id))).not.toContain(claim.token);
  });
  it('serializes competing claims from separate Node processes and survives their exit', async () => {
    const dir = root();
    const path = join(dir, 'state.sqlite');
    const store = open(path);
    const task = store.enqueue(issue(), project, 'user');
    const payload = join(dir, 'issue.json');
    writeFileSync(payload, JSON.stringify(issue()));
    const script = join(dir, 'claim.mjs');
    const storeUrl = new URL('../src/queue/store.ts', import.meta.url).href;
    writeFileSync(
      script,
      `import { QueueStore } from ${JSON.stringify(storeUrl)}; import {readFileSync} from 'node:fs'; const s=new QueueStore(process.argv[2]); try { s.claim(process.argv[3], JSON.parse(readFileSync(process.argv[4],'utf8'))); } catch { process.exitCode=2; } finally {s.close();}`,
    );
    const run = () =>
      new Promise<number | null>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', script, path, task.id, payload],
          { stdio: 'ignore' },
        );
        child.on('error', reject);
        child.on('close', resolve);
      });
    expect((await Promise.all([run(), run()])).sort()).toEqual([0, 2]);
    expect(store.get(task.id).status).toBe('running');
    expect(store.attempts(task.id)).toHaveLength(1);
  });
});

const cwd = fileURLToPath(new URL('..', import.meta.url));
describe('CLI failure handling', () => {
  it('rejects missing approval before invoking GitHub or creating state', () => {
    const dir = root();
    const db = join(dir, 'state.sqlite');
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'enqueue', '1', '--db', db],
      { cwd, encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--approved-by');
  });
  it('handles unavailable GitHub authentication without exposing stderr secrets or losing existing tasks', () => {
    const dir = root();
    const db = join(dir, 'state.sqlite');
    const task = open(db).enqueue(issue(), project, 'user');
    const config = join(dir, 'project.json');
    writeFileSync(config, JSON.stringify(project));
    const gh = join(dir, 'gh');
    writeFileSync(
      gh,
      '#!/bin/sh\necho "HTTP 401 synthetic-private-token" >&2\nexit 1\n',
      { mode: 0o700 },
    );
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/cli.ts',
        'enqueue',
        '1',
        '--db',
        db,
        '--config',
        config,
        '--approved-by',
        'user',
      ],
      {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('authentication required');
    expect(result.stderr).not.toContain('synthetic-private-token');
    const listed = JSON.parse(
      execFileSync(
        process.execPath,
        ['--import', 'tsx', 'src/cli.ts', 'queue', '--db', db],
        { cwd, encoding: 'utf8' },
      ),
    ) as { id: string }[];
    expect(listed[0]?.id).toBe(task.id);
    expect(readFileSync(config, 'utf8')).toContain('fixture/project');
  });
  it.each([
    ['HTTP 403 synthetic-private-token', 'permission denied or rate limited'],
    ['HTTP 429 synthetic-private-token', 'permission denied or rate limited'],
    [
      'connection refused synthetic-private-token',
      'network, response or API failure',
    ],
  ])('sanitizes GitHub failure %s', (stderr, expected) => {
    const dir = root();
    const config = join(dir, 'project.json');
    writeFileSync(config, JSON.stringify(project));
    writeFileSync(
      join(dir, 'gh'),
      `#!/bin/sh\necho '${stderr}' >&2\nexit 1\n`,
      { mode: 0o700 },
    );
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/cli.ts',
        'enqueue',
        '1',
        '--db',
        join(dir, 'state.sqlite'),
        '--config',
        config,
        '--approved-by',
        'user',
      ],
      {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(expected);
    expect(result.stderr).not.toContain('synthetic-private-token');
  });
});
