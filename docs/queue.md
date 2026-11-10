# Approved-ticket queue

[Issue #3](https://github.com/aarondewindt/code-foundry/issues/3) owns the
specification. These are operating instructions for the CLI/state implementation.
There is no background worker or integrated OpenCode launch. A queue claim is a
manual state reservation; it does not establish that an implementation occurred.

Create a local project config, for example `/tmp/code-foundry-project.json`:

```json
{
  "repository": "aarondewindt/code-foundry",
  "taskRoot": "/tmp/code-foundry-tasks",
  "validation": [["yarn", "check"]],
  "serviceRefs": { "database": "representative-postgres" },
  "defaultProfile": "local",
  "profiles": {
    "local": {
      "agent": "build",
      "provider": "ollama",
      "model": "gpt-oss:20b",
      "runtimeSeconds": 120,
      "maxToolCalls": 40,
      "maxRepairs": 1
    }
  },
  "allowedOverrides": ["runtimeSeconds"]
}
```

Profiles and service references contain no credentials, environment blocks or
credential-bearing URLs. Validation commands are argument arrays for later
execution, not shell strings, and must not include secrets. This phase records
commands and task roots but does not execute or create them. Relative task roots
resolve against the config file directory. Model/provider availability and
execution-profile limits are verified/enforced when execution is implemented.

Build and enqueue an explicitly approved issue:

```sh
yarn build
node dist/cli.js enqueue 3 --config /tmp/code-foundry-project.json \
  --approved-by 'User explicitly requested implementation of issue #3' \
  --runtime-seconds 180
node dist/cli.js queue
node dist/cli.js task <task-id>
node dist/cli.js events <task-id>
```

Use an actual task ID in place of `<task-id>`. `--db /absolute/private/state.sqlite`
selects a separate state store for an experiment; otherwise the CLI uses
`$XDG_STATE_HOME/code-foundry/state.sqlite` or
`~/.local/state/code-foundry/state.sqlite`. State contains issue specifications,
comments and authorization records: keep it private and outside agent mounts.
SQLite uses Node 26's built-in driver, schema versioning, WAL, full synchronous
writes, a busy timeout and immediate transactions. No new package is needed.

GitHub reads use bounded `gh api --method GET` calls with structured JSON and
paginated comments/dependencies. The supervisor's existing authenticated identity
is used; no login is performed. Native blocking dependencies and issue-body
`## Blocked by` GitHub links are inspected. Unknown, inaccessible or cross-project
blocking information prevents admission/execution. Cross-project dependency
resolution is intentionally unsupported in this first configured-project CLI.
Authentication/rate-limit/network errors return sanitized guidance and preserve
existing state; no GitHub write command is implemented.

Repeated enqueue is idempotent for the same specification and configuration.
An explicitly approved enqueue can replace a queued/blocked task's specification
or profile while preserving prior approval events. Started/terminal task approvals
cannot be replaced. Claim refreshes GitHub data and blocks if dependencies remain
open or issue title/body/labels/comments/milestone changed since approval; enqueue
again with explicit approval for a changed specification.

```sh
node dist/cli.js claim <task-id>
```

The JSON response contains the attempt ID and ownership token. Only one active
claim is allowed per state store, including across processes and restarts. Each
attempt retains its issue, profile, configuration and approval snapshot. Restart
preserves active claims; it never silently requeues or launches a duplicate.

For a manually reconciled mock attempt that launched no process:

```sh
node dist/cli.js transition <task-id> blocked \
  --attempt <attempt-id> --token <ownership-token> \
  --reason 'Mock reservation inspected; no process was launched'
```

Running transitions require the active attempt's ownership. Queued/blocked tasks
can be cancelled with an explicit reason. Terminal tasks cannot be moved back to
running. This state API cannot prove external process termination: actual worker
pause/takeover and restart reconciliation belong to B4, and must verify termination
before releasing ownership. Never use a manual transition to release a real agent
that could still be writing. No agent process exists in this phase.

GitHub write authorization/auditing has no implemented mutation path in B1. Future
write operations must be separately authorized and audited by the supervisor.
No worker, auto-push, PR publication, cleanup or deployment is included.
