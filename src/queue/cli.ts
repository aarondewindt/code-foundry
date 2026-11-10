import { EnvironmentManager } from '../environment/manager.js';
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
No agent execution or GitHub writes are implemented.`;

export function queueCommand(args: string[]): unknown {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      db: { type: 'string' },
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
  const count = command === 'queue' ? 1 : command === 'transition' ? 3 : 2;
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
    switch (command) {
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
