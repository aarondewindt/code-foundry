import { reviewPackage } from '../review/package.js';
import { parseReview } from '../review/findings.js';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { EnvironmentManager } from '../environment/manager.js';
import { ExecutionLockUnavailable } from '../execution/lock.js';
import { resourcePressure } from '../execution/resources.js';
import {
  ExecutionController,
  type ExecutionRecord,
} from '../execution/controller.js';
import { readEnvironmentConfig } from '../environment/system.js';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { readProject } from './config.js';
import type { Overrides } from './config.js';
import { fetchIssue, parseIssue } from './github.js';
import { QueueStore } from './store.js';
import type { Status } from './store.js';

export const queueUsage = `Queue commands (JSON output):
  enqueue <issue URL | owner/repo#number | number> --config <file> --approved-by <source>
    [--profile <name>] [--model <model>] [--runtime-seconds <seconds>]
  prepare <id> --environment-config <file>
  execute <id>                  Run one approved task in its ready B2 environment
  execute-next                 Run the next ready approved task
  pause <id>                    Request a bounded graceful stop
  takeover <id>                 Request a stop before manual editing
  force-stop <id>               Request immediate termination
  reconcile <id> [--legacy-supervisor-exited] Fence an interrupted attempt
  resume <id> [--fresh-session] Start a new attempt with retained evidence
  review-package <id> --output <file> [--pr <number>]
  record-review <id> --file <findings.json>
  correct <id> --review <review-id> --approved-by <source>
  pressure                      Show current supervisor resource pressure
  logs <attempt-id>             List private stdout and stderr artifact paths
  execution <attempt-id>        Inspect durable execution evidence
  environment <id>
  environment-owner <id>       Supervisor-only recovery token
  readiness <id>
  recover-environment <id> --attempt <id> --token <token>
  queue
  task <id>
  events <id>
  claim <id>                    Revalidate GitHub and reserve; launches no process
  transition <id> <status> --reason <text> [--attempt <id> --token <token>]

All commands accept --db <file>. Default: $XDG_STATE_HOME/code-foundry/state.sqlite
(or ~/.local/state/code-foundry/state.sqlite).
An active claim survives restart and requires explicit owner reconciliation.
Execution never performs GitHub writes. Interrupted executions require explicit reconciliation.`;

export async function queueCommand(args: string[]): Promise<unknown> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      db: { type: 'string' },
      output: { type: 'string' },
      file: { type: 'string' },
      review: { type: 'string' },
      pr: { type: 'string' },
      'fresh-session': { type: 'boolean' },
      'legacy-supervisor-exited': { type: 'boolean' },
      config: { type: 'string' },
      'approved-by': { type: 'string' },
      profile: { type: 'string' },
      model: { type: 'string' },
      'runtime-seconds': { type: 'string' },
      reason: { type: 'string' },
      attempt: { type: 'string' },
      token: { type: 'string' },
      'environment-config': { type: 'string' },
    },
  });
  const [command, subject, target] = positionals;
  const allowed: Record<string, string[]> = {
    enqueue: ['config', 'approved-by', 'profile', 'model', 'runtime-seconds'],
    prepare: ['environment-config'],
    execute: [],
    'execute-next': [],
    pause: [],
    takeover: [],
    'force-stop': [],
    reconcile: ['legacy-supervisor-exited'],
    'review-package': ['output', 'pr'],
    'record-review': ['file'],
    correct: ['review', 'approved-by'],
    resume: ['fresh-session'],
    pressure: [],
    execution: [],
    logs: [],
    environment: [],
    'environment-owner': [],
    readiness: [],
    'recover-environment': ['attempt', 'token'],
    queue: [],
    task: [],
    events: [],
    claim: [],
    transition: ['reason', 'attempt', 'token'],
  };
  if (!command || !Object.hasOwn(allowed, command))
    throw new Error('Unknown arguments. Use --help for usage.');
  const count = ['queue', 'execute-next', 'pressure'].includes(command)
    ? 1
    : command === 'transition'
      ? 3
      : 2;
  if (
    positionals.length !== count ||
    Object.keys(values).some(
      (key) => key !== 'db' && !allowed[command]?.includes(key),
    )
  ) {
    throw new Error('Invalid command arguments. Use --help for usage.');
  }
  const stateRoot = process.env.XDG_STATE_HOME;
  if (stateRoot && !stateRoot.startsWith('/'))
    throw new Error('XDG_STATE_HOME must be absolute');
  const db = resolve(
    values.db ??
      join(
        stateRoot ?? join(homedir(), '.local/state'),
        'code-foundry/state.sqlite',
      ),
  );
  // Validate and retrieve before creating state for an enqueue that cannot succeed.
  const approval = command === 'enqueue' ? values['approved-by'] : undefined;
  let prepared;
  if (command === 'enqueue') {
    if (!values.config || !approval?.trim())
      throw new Error(
        'enqueue requires --config and an explicit --approved-by source',
      );
    const project = readProject(resolve(values.config));
    const overrides: Overrides = {};
    if (values.model !== undefined) overrides.model = values.model;
    if (values['runtime-seconds'] !== undefined)
      overrides.runtimeSeconds = Number(values['runtime-seconds']);
    prepared = {
      project,
      issue: fetchIssue(parseIssue(subject!, project.repository)),
      overrides,
    };
  }
  const store = new QueueStore(db);
  try {
    const manager = new EnvironmentManager(store, db);
    const controller = new ExecutionController(store, manager);
    switch (command) {
      case 'review-package':
        if (!values.output) throw new Error('review-package requires --output');
        return reviewPackage(
          store,
          subject!,
          resolve(values.output),
          values.pr,
        );
      case 'record-review': {
        if (!values.file) throw new Error('record-review requires --file');
        const metadata = statSync(values.file);
        if (!metadata.isFile() || metadata.size > 64000)
          throw new Error('Expected a bounded review JSON file');
        return store.recordReview(
          subject!,
          parseReview(JSON.parse(readFileSync(values.file, 'utf8')) as unknown),
        );
      }
      case 'correct': {
        if (
          !values.review ||
          !values['approved-by']?.trim() ||
          values['approved-by'].length > 500
        )
          throw new Error(
            'correct requires --review and an explicit --approved-by source',
          );
        const task = store.get(subject!);
        return await controller.correct(
          task.id,
          fetchIssue({ repository: task.repository, number: task.number }),
          values.review,
          values['approved-by'],
        );
      }
      case 'pressure':
        return resourcePressure();
      case 'reconcile':
        return controller.reconcile(
          subject!,
          values['legacy-supervisor-exited']
            ? { legacySupervisorExited: true }
            : undefined,
        );

      case 'pause':
      case 'takeover':
      case 'force-stop': {
        const attemptId = store.requestExecutionControl(subject!, command);
        try {
          return controller.reconcile(subject!, { expectedAttempt: attemptId });
        } catch (error) {
          if (!(error instanceof ExecutionLockUnavailable)) throw error;
          return { attemptId, action: command, status: 'stop-requested' };
        }
      }
      case 'execute-next':
        return await controller.executeNext((task) =>
          fetchIssue({ repository: task.repository, number: task.number }),
        );
      case 'resume':
      case 'execute': {
        const task = store.get(subject!);
        return await controller.execute(
          task.id,
          fetchIssue({ repository: task.repository, number: task.number }),
          command === 'resume',
          values['fresh-session'],
        );
      }
      case 'logs': {
        const execution = store.execution(subject!) as ExecutionRecord | null;
        if (!execution) throw new Error('Unknown execution attempt');
        return existsSync(execution.artifacts)
          ? readdirSync(execution.artifacts, { withFileTypes: true })
              .filter(
                (file) => file.isFile() && /\.(stdout|stderr)$/.test(file.name),
              )
              .map((file) => join(execution.artifacts, file.name))
              .sort()
          : [];
      }
      case 'execution':
        return store.execution(subject!);
      case 'prepare': {
        if (!values['environment-config'])
          throw new Error('prepare requires --environment-config');
        const config = readEnvironmentConfig(
          resolve(values['environment-config']),
        );
        const task = store.get(subject!);
        return manager.prepare(
          task.id,
          fetchIssue({ repository: task.repository, number: task.number }),
          config,
        );
      }
      case 'environment-owner':
        return store.environmentOwner(subject!);
      case 'environment':
        return store.environment(subject!);
      case 'readiness': {
        const environment = store.environment(subject!);
        if (!environment) throw new Error('No environment reserved');
        return manager.check(environment);
      }
      case 'recover-environment': {
        if (!values.attempt || !values.token)
          throw new Error('Recovery requires active --attempt and --token');
        const environment = store.environment(subject!);
        if (!environment) throw new Error('No environment reserved');
        return manager.recover(environment, values.attempt, values.token);
      }
      case 'enqueue':
        return store.enqueue(
          prepared!.issue,
          prepared!.project,
          approval!,
          values.profile,
          prepared!.overrides,
        );
      case 'queue':
        return store
          .list()
          .map(({ id, repository, number, status, reason, updatedAt }) => ({
            id,
            repository,
            number,
            status,
            reason,
            updatedAt,
          }));
      case 'task':
        return {
          task: store.get(subject!),
          attempts: store.attempts(subject!),
          reviews: store.reviews(subject!),
          execution: store.latestExecution(subject!),
          environment: store.environment(subject!),
        };
      case 'events':
        return store.events(subject!);
      case 'claim': {
        const task = store.get(subject!);
        return store.claim(
          task.id,
          fetchIssue({ repository: task.repository, number: task.number }),
        );
      }
      case 'transition': {
        if (!values.reason) throw new Error('transition requires --reason');
        const statuses: Status[] = [
          'queued',
          'blocked',
          'running',
          'candidate-ready',
          'failed',
          'needs-local-repair',
          'paused',
          'cancelled',
        ];
        if (!statuses.includes(target as Status))
          throw new Error('Unknown task state');
        const ownership =
          values.attempt && values.token
            ? { attemptId: values.attempt, token: values.token }
            : undefined;
        return store.transition(
          subject!,
          target as Status,
          values.reason,
          ownership,
        );
      }
    }
  } finally {
    store.close();
  }
}
