# OpenCode execution

[Issue #5](https://github.com/aarondewindt/code-foundry/issues/5) is authoritative.
The `execute` command runs one explicitly approved, prepared synthetic task. It
does not discover tickets or run a background scheduler. B2's container flags and
image pins remain unchanged. Trusted Python startup now uses isolated mode to
exclude worktree modules and user-site hooks, including in B2's readiness probe.
This changes the source/profile fingerprint: the earlier B2 host export remains
historical evidence, and existing environments with its old fingerprint fail
closed. Fresh representative-host verification for this fingerprint passed on
2026-11-24; manifests are never automatically re-signed or upgraded.
Use the same supervisor source/build artifact for preparation and execution:
the fingerprint includes its runtime bytes.

```sh
node dist/cli.js execute TASK_ID --db /private/state.sqlite
node dist/cli.js task TASK_ID --db /private/state.sqlite
node dist/cli.js execution ATTEMPT_ID --db /private/state.sqlite
```

Execution re-fetches the issue and blockers using supervisor-only GitHub access.
Changed specifications require reapproval. A ready B2 environment and current
security preflight are mandatory. The first supported profile is the pinned
OpenCode 1.19.5 `build` agent with the approved Ollama model. OpenCode owns native
tools, skills and session data. Optional profile `instructions` and `skills` are
lists of project-relative instruction files and native skill directories.
Existing profiles remain valid. Other providers/agents fail closed pending
verification. No Codex backend is provided.

SQLite records an immutable claim snapshot and a separate execution reservation
in the same transaction before launch, then records exact container IDs, session ID, process outcomes,
individual validation results, timestamps and private artifact paths. The state
schema migrates existing queue/environment databases to version 5. Only one
execution claim is active. Repeating `execute` cannot replay a running or terminal
task. Raw JSONL and stderr are private files, capped at 2 MiB per stream, outside
worker mounts. Native session data stays in the retained task directory. Treat
all model/tool output as untrusted; logs can contain task database credentials.
Baseline and candidate diffs are captured separately against B2's recorded base,
so existing task edits remain distinguishable during review.

Each coding or validation process gets its own restricted container using the B2
profile. Actual image, ownership, mounts, privileges and resource settings are
inspected. Containers are stopped and checked before validation/continuation;
tests never run alongside a coding worker. No supervisor credentials, control
files, Docker socket or network route to GitHub is exposed. Task databases and
read-only attachments retain their B2 restrictions. The only model path for a
coding, validation or diff worker is a supervisor-owned budget socket, forwarding
to the B2 gateway. Validation cannot bypass the budget through the original model
socket. The trusted wrapper does not run OpenCode for validation, and project
validation code remains subject to the same socket and attempt budgets.

The original profile deadline includes readiness, coding, validation and all
repairs. An independent supervisor process stops each exact container at its
deadline even if the controller dies; its private identity record accompanies
the logs. Container-local `timeout` and the live controller provide additional
limits. Durable claims remain held after uncertain termination or unexpected
runtime failure; the execution record reports a blocked outcome while the task's
running claim stays reserved. Manual task transitions cannot release an active execution.
Use the recovery commands below after an interruption.

The budget proxy buffers each model response, including SSE, and counts parallel
tool calls before releasing any tool arguments to OpenCode. A batch exceeding
the remaining `maxToolCalls` is rejected entirely. This counts native model tool
calls, not shell commands or individual operations inside a tool. The proxy also
counts proposed calls that do not produce an executed native tool event. All
native model requests share the budget. Request limits, bounded framing and
response size, a single inference request and the shared
deadline bound retries. The original gateway's smaller request limit can also
stop execution; it is never increased automatically. Response buffering adds
latency and intentionally removes incremental model output at the adapter.

Validation uses the project's approved command arrays with no host shell. Each
command has at most 120 seconds and shares the remaining execution deadline.
Exit 1/2 with recognized code/test diagnostics may trigger a native continuation with the exact recorded session ID
and bounded failure excerpts. Other exits, limits, policy denials, ambiguity or
missing native completion stop automatic repair. Repeated failing command/exit
sets stop repairs even when output timestamps differ. `maxRepairs` is capped at
3, runtime at 3,600 seconds and tool calls at 1,000; none are reset on repair.

OpenCode must explicitly report `CF_RESULT: candidate`, `CF_RESULT: blocked` or
`CF_RESULT: needs-local-repair` at the end of its final response, either on its own
line or as a sentence suffix. Quoted examples, trailing explanation and stale
markers from earlier steps do not satisfy this gate. This is a reporting signal,
not authorization. A successful completed native session, passing independent
validation and a captured diff against B2's recorded base produce
`candidate-ready`. Tests and model reports cannot approve a change: independent
review must check the retained diff, local commits, test changes and unresolved
ticket criteria. Nothing pushes, creates PRs, merges, deploys or closes issues.
Untracked files remain in the retained worktree and should be inspected too.

Each coding invocation supplies OpenCode's native `--title` using the task and
attempt identity. This prevents automatic title inference from competing with
implementation inference under the existing single-request limit. Initial runs
and explicit-session continuations use the same title. The execution record's
`modelDenial` identifies a denied route, concurrency, budget, transport, status or
response-protocol condition without recording request/response contents.

## Pause, takeover and recovery

[Issue #6](https://github.com/aarondewindt/code-foundry/issues/6) specifies
recovery. These commands share the same SQLite state and supervisor lock.

```sh
node dist/cli.js pause TASK_ID --db /private/state.sqlite
node dist/cli.js takeover TASK_ID --db /private/state.sqlite
node dist/cli.js force-stop TASK_ID --db /private/state.sqlite
node dist/cli.js reconcile TASK_ID --db /private/state.sqlite
node dist/cli.js resume TASK_ID --db /private/state.sqlite
node dist/cli.js execute-next --db /private/state.sqlite
node dist/cli.js events TASK_ID --db /private/state.sqlite
node dist/cli.js logs ATTEMPT_ID --db /private/state.sqlite
node dist/cli.js pressure --db /private/state.sqlite
```

A live supervisor consumes a durable stop request. Pause and takeover give
Docker a two-second termination grace period. Force-stop requests zero grace.
Wait for the matching attempt to show `paused` in `task` before editing. A
`stop-requested` response is an acknowledgment only.

After supervisor exit, `reconcile` acquires the kernel lock, checks the Docker
daemon identity, and fences the interrupted attempt's exact containers by
stopping and retiring them. The private attached logs, worktree, session data
and task database are retained. The command leaves the execution active if
termination or daemon ownership cannot be verified. After verified termination,
it records whether B2 readiness still passes and releases the claim. Keep the
SQLite state, lock path and retained resources together across restarts.
Attempts recorded by the previous supervisor version did not use the lock.
For those attempts, verify that the earlier supervisor has exited before using
`reconcile --legacy-supervisor-exited`.

`resume` revalidates the approved issue and runs B2 readiness before starting a
new attempt. The recorded base and branch must still match. The new attempt
captures the tracked diff and lists untracked files before continuing the native
OpenCode session. Use `--fresh-session` if the native session is unavailable.
The private handoff includes the issue, current changes, earlier validation,
blockers and next steps. No previous command is automatically replayed during
reconciliation.

`execute-next` selects from approved tasks with ready environments, skipping
blocked and deferred tasks. A profile can set `admission.maxCpuLoadPerCore`,
`admission.minAvailableRamMiB`, `admission.maxGpuPercent` or
`admission.minAvailableVramMiB`. GPU limits defer admission when NVIDIA
telemetry is unavailable. Resource samples reflect the supervisor's view.
Execution also stops after four consecutive identical native tool inputs or a
repeated set of failing validation command exits within an attempt.

## Verification and evidence limits

The [B4 results](experiments/b4/results.json) record the recovery fixtures and
restricted-guest takeover and resume trial.

The [retained B3 results](experiments/b3/results.json) distinguish local controller
verification from real-model acceptance and preserve unsuccessful trial evidence.

The [2026-11-23 host review](experiments/b3/host-2026-11-23.json) records a trial
that stopped before coding and the title-inference contention reproduced with
the pinned CLI. The [second host review](experiments/b3/host-2026-11-23-2.json)
confirms successful real-model coding without a model denial, followed by an
overly strict disposition-parser rejection.
The copied pure-code candidate passed independent local review and validation;
the [2026-11-24 host acceptance](experiments/b3/host-2026-11-24.json) then passed
the full corrected controller path with real OpenCode/Ollama, independent
validation, two ready environments and matching current source hashes. The final
candidate passed its unchanged fixture test and 37,191 independently checked
valid numeric ranges. The copied SQLite rows, supervisor manifests and exported
reports agree. This is reviewed operator evidence, not live host attestation.

The optional protocol regression needs local OpenCode 1.19.5, but no Docker or
Ollama. It uses a delayed fixed-text server, denies every tool, reproduces the
untitled concurrency denial and verifies titled execution/continuation:

```sh
node --import tsx test/execution-protocol.ts
```

`yarn check` exercises deterministic failures, claim persistence, session identity,
repair exhaustion, process/log bounds and budget enforcement. The disposable VM
suite additionally exercises the pinned real OpenCode binary, native shell tools,
session continuation, a failed test followed by repair, deterministic validation
and a denied attachment write. The recovery fixture prepares both environments
before coding, kills the supervisor after a native tool event and reopens SQLite.
It checks duplicate-start refusal, worker termination, retained worktree and
database readiness, and continuation through takeover and a manual edit. It
checks the second environment again after the workload. The guest uses scripted
model responses. The existing VM CPU/memory/TCG settings, image archive,
network isolation and historical evidence limits remain unchanged.

```sh
CF_INTEGRATION_IMAGES=/workspaces/code-foundry/scratch/reviewed-images.tar yarn check:integration
```

Real OpenCode/Ollama acceptance for the representative controller is complete,
separately from the scripted VM trial. The earlier A2 experiment remains
historical boundary/capability evidence. The ordinary VM deliberately has no
route to host Ollama. To repeat host verification for future relevant changes,
an operator on the verified representative host can explicitly run:

```sh
CF_HOST_VERIFY=disposable-synthetic-opencode-only node --import tsx test/execution-host.ts
```

This creates new disposable synthetic resources, uses the existing fixed
supervisor-loopback Ollama endpoint and retains resources/private evidence. It
prints a private report directory containing `execution.json`, `environments.json`
and the captured baseline/candidate patches. Share those reports for review;
do not export raw session data, database credentials or entire task directories.
The report includes the host-helper and fixture source hashes.
It does not inspect existing host task environments. Review the host boundary first;
the shared development container remains NO-GO for unattended coding. Vela,
production safety, real-service side effects and deployment acceptance remain
outside this work.
