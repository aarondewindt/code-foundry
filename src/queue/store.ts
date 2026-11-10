import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Overrides, Profile, Project } from './config.js';
import { resolveProfile } from './config.js';
import type { IssueSnapshot } from './github.js';
import { blockedReason, specificationHash } from './github.js';

export type Status =
  | 'queued'
  | 'blocked'
  | 'running'
  | 'candidate-ready'
  | 'failed'
  | 'needs-local-repair'
  | 'paused'
  | 'cancelled';
export interface Task {
  id: string;
  repository: string;
  number: number;
  status: Status;
  reason: string | null;
  issue: IssueSnapshot;
  project: Project;
  profile: Profile;
  approvalSource: string;
  approvedAt: string;
  createdAt: string;
  updatedAt: string;
}
export interface Claim {
  attemptId: string;
  token: string;
  task: Task;
}
const transitions: Record<Status, Status[]> = {
  queued: ['cancelled'],
  blocked: ['cancelled'],
  running: [
    'candidate-ready',
    'blocked',
    'failed',
    'needs-local-repair',
    'paused',
  ],
  'candidate-ready': [],
  failed: [],
  'needs-local-repair': [],
  paused: [],
  cancelled: [],
};
export class QueueStore {
  readonly #db: DatabaseSync;
  constructor(path: string) {
    const absolute = resolve(path);
    mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
    for (const file of [absolute, `${absolute}-wal`, `${absolute}-shm`]) {
      const metadata = lstatSync(file, { throwIfNoEntry: false });
      if (metadata && (!metadata.isFile() || metadata.isSymbolicLink())) {
        throw new Error('State files must be regular private files');
      }
      if (metadata) chmodSync(file, 0o600);
    }
    this.#db = new DatabaseSync(absolute, {
      timeout: 5_000,
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
    });
    chmodSync(absolute, 0o600);
    this.#db.exec(
      'PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;',
    );
    try {
      this.#transaction(() => {
        const version = this.#db
          .prepare('PRAGMA user_version')
          .get()?.user_version;
        if (version === 0) {
          this.#db.exec(`
            CREATE TABLE tasks (
              id TEXT PRIMARY KEY, repository TEXT NOT NULL, number INTEGER NOT NULL,
              status TEXT NOT NULL CHECK(status IN ('queued','blocked','running','candidate-ready','failed','needs-local-repair','paused','cancelled')),
              payload TEXT NOT NULL, UNIQUE(repository,number)
            );
            CREATE UNIQUE INDEX one_active_execution ON tasks ((1)) WHERE status='running';
            CREATE TABLE attempts (
              id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), token TEXT NOT NULL,
              started_at TEXT NOT NULL, finished_at TEXT, snapshot TEXT NOT NULL, outcome TEXT
            );
            CREATE UNIQUE INDEX one_active_attempt ON attempts ((1)) WHERE finished_at IS NULL;
            CREATE TABLE events (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id),
              at TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL
            );
            PRAGMA user_version=1;
          `);
        } else if (version !== 1)
          throw new Error('Unsupported state schema version');
      });
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }
  close(): void {
    this.#db.close();
  }
  #transaction<T>(action: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
  #event(id: string, kind: string, payload: unknown): void {
    this.#db
      .prepare('INSERT INTO events(task_id,at,kind,payload) VALUES(?,?,?,?)')
      .run(id, new Date().toISOString(), kind, JSON.stringify(payload));
  }
  #save(task: Task): void {
    this.#db
      .prepare('UPDATE tasks SET status=?,payload=? WHERE id=?')
      .run(task.status, JSON.stringify(task), task.id);
  }
  get(id: string): Task {
    const row = this.#db
      .prepare('SELECT payload FROM tasks WHERE id=?')
      .get(id);
    if (!row) throw new Error('Unknown task');
    return JSON.parse(String(row.payload)) as Task;
  }
  list(): Task[] {
    return this.#db
      .prepare('SELECT payload FROM tasks ORDER BY rowid')
      .all()
      .map((row) => JSON.parse(String(row.payload)) as Task);
  }
  events(id: string): unknown[] {
    this.get(id);
    return this.#db
      .prepare(
        'SELECT sequence,at,kind,payload FROM events WHERE task_id=? ORDER BY sequence',
      )
      .all(id)
      .map((row) => ({
        ...row,
        payload: JSON.parse(String(row.payload)) as unknown,
      }));
  }
  attempts(id: string): unknown[] {
    this.get(id);
    return this.#db
      .prepare(
        'SELECT id,started_at,finished_at,snapshot,outcome FROM attempts WHERE task_id=? ORDER BY rowid',
      )
      .all(id)
      .map((row) => ({
        ...row,
        snapshot: JSON.parse(String(row.snapshot)) as unknown,
      }));
  }
  enqueue(
    issue: IssueSnapshot,
    project: Project,
    approvalSource: string,
    selected?: string,
    overrides: Overrides = {},
  ): Task {
    if (!approvalSource.trim() || approvalSource.length > 500)
      throw new Error('Explicit approval source is required');
    if (issue.repository !== project.repository)
      throw new Error('Issue does not match project');
    const profile = resolveProfile(project, selected, overrides);
    return this.#transaction(() => {
      const existing = this.#db
        .prepare('SELECT id FROM tasks WHERE repository=? AND number=?')
        .get(issue.repository.toLowerCase(), issue.number);
      if (existing) {
        const task = this.get(String(existing.id));
        const same =
          specificationHash(task.issue) === specificationHash(issue) &&
          JSON.stringify(task.project) === JSON.stringify(project) &&
          JSON.stringify(task.profile) === JSON.stringify(profile);
        if (same) return task;
        if (!['queued', 'blocked'].includes(task.status))
          throw new Error(
            'Cannot replace approval for a started or terminal task',
          );
        const reason = blockedReason(issue);
        Object.assign(task, {
          issue,
          project,
          profile,
          approvalSource,
          approvedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          reason,
          status: reason ? 'blocked' : 'queued',
        });
        this.#save(task);
        this.#event(task.id, 'approval-replaced', task);
        return task;
      }
      const now = new Date().toISOString();
      const reason = blockedReason(issue);
      const task: Task = {
        id: randomUUID(),
        repository: issue.repository,
        number: issue.number,
        status: reason ? 'blocked' : 'queued',
        reason,
        issue,
        project,
        profile,
        approvalSource,
        approvedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      this.#db
        .prepare(
          'INSERT INTO tasks(id,repository,number,status,payload) VALUES(?,?,?,?,?)',
        )
        .run(
          task.id,
          issue.repository.toLowerCase(),
          issue.number,
          task.status,
          JSON.stringify(task),
        );
      this.#event(task.id, 'approved', task);
      return task;
    });
  }
  claim(
    id: string,
    fresh: IssueSnapshot,
  ): Claim | { task: Task; blocked: true } {
    return this.#transaction(() => {
      const task = this.get(id);
      if (!['queued', 'blocked'].includes(task.status))
        throw new Error('Task is not claimable');
      if (this.#db.prepare("SELECT id FROM tasks WHERE status='running'").get())
        throw new Error(
          'An execution claim is already active; reconcile it before continuing',
        );
      if (fresh.repository !== task.repository || fresh.number !== task.number)
        throw new Error('Revalidation does not match task');
      const reason =
        specificationHash(fresh) !== specificationHash(task.issue)
          ? 'Issue specification changed; enqueue again with explicit approval'
          : blockedReason(fresh);
      if (reason) {
        Object.assign(task, {
          status: 'blocked',
          reason,
          updatedAt: new Date().toISOString(),
        });
        this.#save(task);
        this.#event(id, 'claim-blocked', { reason, issue: fresh });
        return { task, blocked: true };
      }
      const attemptId = randomUUID();
      const token = randomUUID();
      const now = new Date().toISOString();
      const snapshot = {
        issue: fresh,
        project: task.project,
        profile: task.profile,
        approvalSource: task.approvalSource,
        approvedAt: task.approvedAt,
      };
      this.#db
        .prepare(
          'INSERT INTO attempts(id,task_id,token,started_at,snapshot) VALUES(?,?,?,?,?)',
        )
        .run(attemptId, id, token, now, JSON.stringify(snapshot));
      Object.assign(task, { status: 'running', reason: null, updatedAt: now });
      this.#save(task);
      this.#event(id, 'claimed', { attemptId, snapshot });
      return { attemptId, token, task };
    });
  }
  transition(
    id: string,
    target: Status,
    reason: string,
    ownership?: { attemptId: string; token: string },
  ): Task {
    if (!reason.trim() || reason.length > 2_000)
      throw new Error('A bounded transition reason is required');
    return this.#transaction(() => {
      const task = this.get(id);
      if (!transitions[task.status].includes(target))
        throw new Error('Invalid task state transition');
      if (task.status === 'running') {
        const attempt = this.#db
          .prepare(
            'SELECT id,token FROM attempts WHERE task_id=? AND finished_at IS NULL',
          )
          .get(id);
        if (
          !ownership ||
          attempt?.id !== ownership.attemptId ||
          attempt.token !== ownership.token
        )
          throw new Error('Active attempt ownership is required');
        this.#db
          .prepare('UPDATE attempts SET finished_at=?,outcome=? WHERE id=?')
          .run(new Date().toISOString(), target, ownership.attemptId);
      }
      const from = task.status;
      Object.assign(task, {
        status: target,
        reason,
        updatedAt: new Date().toISOString(),
      });
      this.#save(task);
      this.#event(id, 'transition', {
        from,
        to: target,
        reason,
        attemptId: ownership?.attemptId ?? null,
      });
      return task;
    });
  }
}
