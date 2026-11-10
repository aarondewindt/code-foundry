# A2 execution isolation feasibility

**Decision: GO for feasibility of the demonstrated restricted representative
worker profile.** The shared development container remains **NO-GO** for unattended
agents. B2/B3 must implement and verify the demonstrated controls before enabling
execution; Vela-specific acceptance remains #9. This is a scoped feasibility
result, not general production approval or an enabled runner.

[Issue #2](https://github.com/aarondewindt/code-foundry/issues/2) owns acceptance.
The initial investigation below retains its historical evidence. The updated
scope uses representative resources without requiring Vela access. A1's supervised
worktree/skill trial and separate review are now recorded in the
[operating guide](opencode-ollama.md). No Vela-dependent or unattended OpenCode run
was performed here.

The exported Ubuntu host offline probe has now **passed all 23 checks**. The
operator supplied `scratch/code-foundry-a2-host.TEJj9K`; the reviewed evidence is
retained under [host-offline](experiments/a2/host-offline/review.json). Its runtime
record reports non-privileged execution, a read-only root, no network, all
capabilities dropped, no-new-privileges and `docker-default` AppArmor. Every
credential, resource, IPv4/IPv6 and write/delete/chmod/symlink check passed. The
exported original and shared attachment match, and task output is present. These
are reviewed operator-provided files, not a live host inspection from this
container. Their export has no run timestamp or probe-source hash.

The second exported host run also passed: identical host/container worktree
paths, independent metadata, source protection, whole-container termination of
two writing processes, and PostgreSQL **18.6 / pgvector 0.8.7** full snapshot,
vector/HNSW restore, task migration/reset/rollback and SQL shadow-database checks.
All four exported probe-source hashes match the local files. The writer's exit
143 is the expected result of deliberate SIGTERM. The user separately confirmed
that editing the task fixture in host VS Code displays its diff. Original machine
results remain unchanged; the manual confirmation is recorded separately in the
[follow-up review](experiments/a2/host-followup-results/review.json).

The service-enabled host trial has now also passed. Export
`scratch/code-foundry-a2-services-858i4416` matches all six local probe-source hashes.
All **45 worker checks**, **8 host checks** and **2 retry checks** passed:

- Approved model and task/shadow DB access worked while IPv4/IPv6, direct TCP,
  backend sockets, model management/proxy routes, source/default/other-task DBs,
  alternate identities, console access and privileged SQL operations were denied.
- The PostgreSQL 18.6/PgBouncer 1.26.1 service had UID 999, different from the worker;
  its source would permit raw PUBLIC CONNECT but was unreachable through the
  worker's narrowly mapped gateway. Source rows/schema were unchanged.
- Read-only shared attachments remained readable and unchanged; write/delete/chmod
  attempts failed with the gateway sockets mounted.
- A separate supervised process performed one authorized mock side effect. The
  worker and fresh retry could not access its route or change mock state.
- Real OpenCode with `gpt-oss:20b` implemented the clamp fixture in 45.29 seconds.
  Model transport recorded 12 accepted and 15 denied requests, with zero upstream
  errors. Both fixture tests passed, and independent review additionally checked
  7,161 valid numeric ranges and 11 invalid ranges.
- Worker, retry and database containers exited with code 0. Cleanup reported no
  errors. No Vela resource or existing database was accessed.

[Service evidence and review](experiments/a2/host-services-results/review.json)
retain results, image/container identities, model/session data and the candidate
[diff](experiments/a2/host-services-results/implementation.diff). Generated task
credentials, raw OpenCode state and socket nodes are not copied into tracked
evidence. `ollama.sock` is an ephemeral Unix IPC endpoint, not a portable result;
a copy warning for that file does not require rerunning the test.

The tool log retains an actual limitation: three `glob` attempts failed with
`ripgrep execution failed`; OpenCode recovered through `read`, then `edit` and
`bash`. The cause was not established. Verify search-tool availability in the
approved pinned image before accepting tasks that depend on it; do not weaken
mounts, executable restrictions, credentials or network controls as a workaround.

A2's representative feasibility criteria are complete. The verified fixtures are
not an integrated Code Foundry environment manager. #4 must persist ownership,
pin the runtime/gateway profile and fail closed when readiness differs; #5 adds
bounded execution. Preserve host GPU/VRAM and unrelated workload limitations
noted in the operating procedure. Vela-specific migration tools, existing
clusters, private attachments and real side effects remain #9. This devcontainer
still has no Docker access, and no privileges were added.

## Observed environment and Option A

The inspected process is UID/GID 1000 in the Code Foundry container. These are
observations from `/proc`, mount metadata, path-access checks and bounded probes,
not a host-side Docker audit. The developer environment was not reconfigured.

| Area               | Observed                                                                                                                                    | Consequence                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Filesystem         | Workspace and Yarn/node-gyp cache mounts are writable; root filesystem is writable.                                                         | Sharing the user's mount namespace exposes more than one task.                                                                     |
| Credentials        | GitHub config, Git config, SSH directory and Codex directory are readable by this UID; SSH agent socket exists. Values were not read.       | An empty environment alone does not remove credential access.                                                                      |
| GitHub             | Supervisor's read-only repository metadata query reports push/admin rights.                                                                 | This identity must never be inherited by an unattended model process. No mutation was attempted.                                   |
| Privileges         | Effective capabilities zero, bounding set nonzero; `NoNewPrivs=0`; seccomp mode 2. Setuid utilities exist.                                  | Non-root is useful but does not establish a complete boundary. Host Docker flags/filter contents are unknown.                      |
| Child restrictions | A child can set `NoNewPrivs=1`; `unshare --user --map-root-user --net true` fails with EPERM.                                               | That child flag does not restrict filesystem/network access. Do not add privileges or relax seccomp to make Option A work.         |
| Docker             | No Docker/Podman/bubblewrap binary or mounted Docker socket found.                                                                          | This process cannot launch/inspect the proposed sibling container. Do not add the host Docker socket here.                         |
| Network            | Read-only GitHub HTTPS GET succeeds (200); desktop Ollama `/api/version` returns 0.40.14.                                                   | No deny-by-default outbound policy has been established. Home Assistant and live DB endpoints were not probed.                     |
| Resources          | Visible cgroup has `cpu.max=max 100000`, `memory.max=max`, `memory.swap.max=max`, `pids.max=32394`. No GPU device found.                    | No task CPU/RAM budget is visible; inaccessible ancestor limits remain unknown. Ollama's host GPU load is outside this cgroup.     |
| Vela               | No Vela checkout mounted. Read-only repository config uses a Node 24 container, environment files, shared attachments and Docker-in-Docker. | These are repository declarations, not verified live Vela runtime settings. Never launch its Compose stack for this investigation. |

**Option A fails as currently configured.** The harmless tests demonstrate actual
cross-task permissions, not merely the absence of an allowlist. A supervisor
could in principle apply a dedicated OS sandbox inside a container, but that
would require its own tested mount, PID, credential and network boundary. It is
not provided here. OpenCode permissions, Git worktrees, `env -i`, mode bits and
`no_new_privs` alone are insufficient.

Docker's namespace, capability and cgroup controls are relevant to a replacement
profile; do not interpret the presence of a seccomp filter as proof of a specific
policy. See [Docker security](https://docs.docker.com/engine/security/) and
[seccomp](https://docs.docker.com/engine/security/seccomp/).

## Repeatable synthetic evidence

All fixture files contain invented data. Scripts print metadata/results only;
they do not read real credential contents, contact Vela databases or call GitHub
write endpoints. Exit 0 from an inspection script means it completed, **not** that
a security boundary passed. Evidence is retained in
[results.json](experiments/a2/results.json).

```sh
yarn install --immutable
python3 docs/experiments/a2/shared-container-probe.py
python3 docs/experiments/a2/worktree-probe.py
```

| Probe                                                   | Result                                                             | What it establishes                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Child writes sibling file outside task                  | Allowed                                                            | Current UID/mount namespace does not confine writes to the task.                                            |
| Write through symlink to sibling fixture                | Allowed                                                            | A working-directory restriction is not a path boundary.                                                     |
| Write mode-0444 shared fixture                          | EACCES, then allowed after owner chmod                             | Mode bits initially deny writes; an owner can undo them.                                                    |
| Delete synthetic shared attachment                      | Allowed                                                            | Parent-directory permissions also matter; mode-0444 alone is inadequate.                                    |
| Empty-environment child reads mode-0600 synthetic token | Allowed                                                            | Same-UID home/credential files must be absent or inaccessible, not just omitted from environment.           |
| Signal controlled sibling `sleep` process               | Allowed                                                            | Tasks in the same PID/UID domain can affect each other. No unrelated process was signalled.                 |
| POST to loopback GitHub-shaped mock endpoint            | 204                                                                | The shared environment permits network writes to a reachable service. This is not a live GitHub write test. |
| `gh` without tokens and with empty config               | Exit 4, login guidance                                             | Missing authentication fails safely; it is not an outbound-write firewall.                                  |
| Create child user/network namespace                     | Exit 1, EPERM                                                      | This unprivileged namespace approach is unavailable as attempted; cause was not isolated.                   |
| Independent synthetic worktree                          | Source clean, distinct common Git directory, no hardlinked objects | A task-owned repository can keep main-source files/metadata independent.                                    |
| Relocate synthetic worktree/store prefix                | Git exit 128; `git worktree repair` restores diff                  | Host/container absolute-path identity must be designed explicitly.                                          |

No real GitHub mutation, Home Assistant request, host escalation, privileged Docker
operation or protected-file write was attempted. Those denial checks belong in a
restricted environment using synthetic targets. Their absence is an acceptance
blocker, not a successful denial result.

## Proposed Option B and host verification

Use a trusted host-side supervisor to create a **plain sibling container**, not
another privileged development container. Docker authority stays with that
supervisor, outside the agent. Initially use a fresh non-root process per task,
private PID/IPC namespaces, a read-only root filesystem, all capabilities dropped,
`no-new-privileges`, default seccomp and an applicable host LSM profile. No device,
host PID/network namespace, Docker socket, SSH-agent socket, developer HOME,
credential helper, Vela normal checkout, shared cache or live environment file
is mounted. Pin/review the image; do not discover/download packages during an
unattended task. Keep dependencies and approved skills in the image or a reviewed
read-only snapshot. Lifecycle scripts execute only within this same boundary.

Writable mounts contain only that task's worktree, its independent Git metadata,
private build/cache/session state and output files. The task cannot edit the
supervisor's ownership manifest or authorization record. Start with finite CPU,
RAM/swap, PID and tmpfs limits; also bound host Ollama concurrency and requests
outside the agent. Per-gateway concurrency/request limits were exercised in the host trial; host
GPU/VRAM admission and unrelated-client load remain unmeasured.
[Docker runtime controls](https://docs.docker.com/engine/containers/run/) provide
these primitives. The offline probe has passed in the exported host run; the
service-enabled profile and termination probes also passed in the reviewed exports.

The [host procedure](experiments/a2/host-procedure.md) records the reviewed offline
probe and completed follow-up checks for the demonstrated candidate. It mounts synthetic attachments read-only and tests root and
shared-file writes/deletes/chmod, symlink writes, missing credentials, capabilities,
resource settings and IPv4/IPv6 network denial. Ordinary mount flags are the
intended OS enforcement, not OpenCode configuration. Disable nested bind mounts
or verify recursive read-only behavior; inspect the actual runtime mount flags.
[Read-only bind mounts](https://docs.docker.com/engine/storage/bind-mounts/#use-a-read-only-bind-mount)
are necessary even when the file owner matches the container user.

For the simplest network boundary, start with `--network none`, which provides
[loopback only](https://docs.docker.com/engine/network/drivers/none/). This also
blocks direct Ollama and PostgreSQL connectivity: an offline probe pass alone is
**not** a successful integration profile. Before allowing coding runs, separately
validate narrowly mounted, supervisor-owned service gateways:

- Ollama: a Unix-socket HTTP gateway with a fixed upstream, explicit inference
  route/model allowlist, bounded requests and no model pull/delete/push or cloud
  routes. A container-local loopback adapter can present HTTP to OpenCode. Do not
  assume OpenCode supports Unix sockets through `baseURL`; that adapter and
  end-to-end connectivity are untested. Arbitrary CONNECT, URLs and redirects
  must not open a general proxy. Secrets in model input require the same approved
  data handling as the clone itself.
- PostgreSQL: a per-task Unix-socket gateway exposing only the recorded task DB,
  using its restricted role. A candidate is PgBouncer with one explicit database
  mapping, no wildcard/admin-console access and session pooling; its
  [configuration](https://www.pgbouncer.org/config.html) supports Unix sockets and
  named database mappings. Test alternate database/user startup values and all
  direct TCP/socket bypasses; the prototype configuration passed local SQL regression and the PostgreSQL 18
  restricted-worker host trial, including alternate database/user denial.
- GitHub: provide the sanitized approved issue through the supervisor. Agent
  GitHub access is absent by default; supervisor read access uses the least
  necessary identity. All writes require separate approval and stay outside the
  agent. Do not forward the current developer identity even for reads.
- Other integrations: no Home Assistant or live-service path, credential or
  permissive fallback. Dependencies use fixtures/stubs. An unrestricted egress
  proxy or host-port allowlist for the entire Ollama API is not sufficient.

A Docker `internal` network, environment proxy settings or a prompt to avoid
external services is not a substitute for verified egress controls. If gateways
cannot be restricted or Vela's client libraries cannot use them, stop that task;
a host-approved firewall design or a more isolated deployment needs separate
verification, not automatic relaxation.

## Worktree and attachment design

The probe seeded a new synthetic repository under the existing host-backed,
ignored `node_modules/.cache`, then cloned a **task-owned bare store** using
`--no-hardlinks` and created branch `a2-synthetic-task` plus a worktree. The only
seed commit and branch were in that disposable fixture, not Code Foundry or Vela.
All fixture repositories were removed afterward. Neither Ubuntu access nor
opening VS Code was testable from this process.

For Vela, have the trusted supervisor prepare each task's own store/worktree from
an approved base, with no object alternates or hardlinks back to the normal Vela
repository. The additional disk usage is acceptable initially. Mounting Vela's
shared common `.git` writable would let a task affect other branches/worktrees;
a different checkout directory is not a Git-metadata security boundary.
[Git worktree documentation](https://git-scm.com/docs/git-worktree) describes
shared metadata and relocation/repair.

Use a canonical absolute task root on Ubuntu, for example
`/srv/code-foundry/tasks/<id>/{store.git,worktree,state}`, and mount that exact path
at the same absolute location in the task container. Each container sees only its
own task root, not the parent directory or other tasks. Host VS Code opens the
worktree directory. Verify both `.git`'s gitdir pointer and the worktree metadata's
back-pointer from both environments. Host path selection/creation and the VS Code
opening test remain manual; do not patch Vela's normal `.git` to work around a
path mismatch. Disable automatic credential forwarding in any task inspection
container, and stop the agent before human edits.

Vela's [attachment guide](https://github.com/aarondewindt/vela/blob/master/docs/ATTACHMENTS.md)
places originals under a private storage root, separate from database metadata.
Only approved reads should be exposed through a read-only bind of a constrained
snapshot/subtree; generated uploads belong to the task's own writable directory.
Do not create a writable overlay that accidentally exposes originals through
another mount, symlink or service. A full writable disposable attachment copy is
an alternative when deletion/lifecycle tests need it, subject to privacy and
capacity approval. Prefer synthetic attachments until that approval exists.
Database and attachment snapshots are not automatically mutually consistent;
coordinate a documented snapshot window or accept an explicit test limitation.
Live attachment read-only mount denial is unverified here.

## PostgreSQL experiment and feasibility

A new PostgreSQL **15.19** cluster ran as UID 1000 from extracted Debian packages
in `/tmp`. It listened only on a private Unix socket, used generated per-run SCRAM
passwords and contained invented rows/tokens only. No Vela env file was loaded;
no existing database was contacted. Its scripts never consume `DATABASE_URL` or
inherited PostgreSQL credentials. The cluster and dumps were removed after stopping
it, including on the two failed setup attempts.

The [reproduction commands](experiments/a2/host-procedure.md#synthetic-postgresql-reproduction)
and [database probe](experiments/a2/database-probe.py) establish:

- An exported repeatable-read snapshot plus full `pg_dump -Fc --snapshot` restored
  two rows even after a deliberate synthetic writer added a third to the source.
  The clone included schema, index, view, sequence and large-object contents.
  No table/schema filters were used. The source's synthetic writer is part of the
  fixture, not an unauthorized write to Vela.
- Sequence `last_value` was 3 while the snapshot had 2 rows. Do not promise an
  exact point-in-time sequence value: PostgreSQL sequences are not transactional
  like table rows. The gap is safe for these tests, not proof of a physical clone.
  [Snapshot options](https://www.postgresql.org/docs/current/app-pgdump.html) and
  [sequence semantics](https://www.postgresql.org/docs/15/functions-sequence.html)
  explain the relevant behavior.
- Restoring without source owners/ACLs into a task-owned DB initially failed on
  public-schema CREATE permissions. The `NOINHERIT` task role required an explicit
  `GRANT USAGE, CREATE ON SCHEMA public` **in the synthetic target only**. After
  that, restore and task-only migration succeeded without a superuser task role.
- A failed transactional migration rolled back its column addition (exit 3).
  Resetting the clone to zero rows left the synthetic source's rows and schema
  unchanged. The script then dropped its task DB and stopped the synthetic cluster.
- `REVOKE CONNECT ... FROM task_role` did not prevent source connection because
  `PUBLIC` still granted CONNECT. Source table reads were already denied, but
  that is weaker than connection denial. Revoking PUBLIC in the synthetic source
  denied connection (exit 2); default `postgres` DB connection still succeeded.
  Per-role ACL changes alone are not a database-name allowlist.
  [PostgreSQL REVOKE](https://www.postgresql.org/docs/current/sql-revoke.html)
  documents cumulative direct, membership and PUBLIC grants.
- The full clone copied an invented token unchanged. A real full copy also carries
  whatever sensitive data the source contains; omitting an environment file does
  not scrub cloned credentials, sessions or private records.

These are SQL-role tests **within a same-UID owned fixture**, not an agent security
boundary: that UID can access the cluster files and generated admin credentials.
The repository declares Vela PostgreSQL **18** with pgvector **0.8.7**. Its live
version, permissions, extensions, FDWs/functions, data sensitivity and restore
behavior have not been inspected. PostgreSQL 15 success does not satisfy that
integration acceptance criterion.
The fixture contains no pgvector extension. Its installation/restore may need
supervisor-only privileged preparation; verify extension ownership and the
complete restore with task privileges rather than broadening the task role.

For an approved existing-cluster trial, prefer a complete logical dump/restore
into a unique task-owned DB. [pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html)
provides a consistent single-database export while ordinary source writes continue;
use bounded lock/statement timeouts and resource admission to avoid disrupting
shared work. Include application schemas, all data, sequences, large objects and
required extensions; validate a source-to-clone inventory and migration history.
Map owners/ACLs/settings deliberately rather than copying cluster-admin identities.
A dump is not a cluster-wide backup of roles/configuration.

`CREATE DATABASE ... TEMPLATE source` is not the default plan: it requires elevated
authority and conflicts with concurrent source connections. Do not disconnect
source users or disable its connections to make cloning pass. See
[CREATE DATABASE](https://www.postgresql.org/docs/current/sql-createdatabase.html).

Only the supervisor gets provisioning/snapshot credentials, with source read-only
privileges appropriate for a complete export. Task roles get no SUPERUSER,
CREATEDB, CREATEROLE, REPLICATION, server-file/program roles or membership in other
task roles. Give target-schema privileges explicitly. Do not hand the agent a
supervisor password for migrations or Prisma shadow-database creation: provision
and bind an additional verified task-only shadow DB if the approved workflow needs
one. Test real Prisma migrations and both URLs on PostgreSQL 18 before acceptance.

Enforce database-name admission at the gateway and, if approved, role-scoped server
rules. [pg_hba.conf](https://www.postgresql.org/docs/current/auth-pg-hba-conf.html)
can restrict database/user/address combinations; first matching rules win. Changing
shared HBA/ACLs requires separate host/DB-owner approval. Never globally revoke
PUBLIC on a live database as an unreviewed test shortcut. Check extensions,
SECURITY DEFINER routines and foreign servers for server-side routes around the
network boundary; the DB server's network access is outside the agent's namespace.
A full sensitive dump must stay private with protection at least as strong as the
source. If that cannot be established, do not copy it; synthetic-only results do
not satisfy the full-copy requirement.

## Ownership, interruption and supervised exceptions

Record immutable task ID, approved base, branch, absolute task root, image ID,
container ID/labels, UID, database/role names and OIDs, gateway identity, attachment
source/snapshot, created resources and authorization in a supervisor-only manifest.
A name prefix alone is not ownership evidence. No durable state implementation
was added under A2; that belongs to later issues.

On timeout/takeover: stop the whole agent container and verify it exited before
human edits; OpenCode idle/abort alone does not establish tool-process termination.
Revoke gateway access and reconcile container/process/worktree/DB state before
retrying. Do not replay a restore/migration with an unknown outcome. Preserve the
worktree/session/output and label partial provisioning failures for inspection.
Cleanup is an explicit supervisor action only: verify manifest ownership, no
active task, retained diff/review requirements and exact DB/role identity before
removing that task's resources. Never enumerate-and-delete by wildcard/prefix or
force-remove the normal checkout. Shared cache volumes remain unmounted.

Tests requiring real Home Assistant or other live side effects **stop and request
specific approval**. The operator reviews the exact endpoint/action and runs it
in a separate supervised process with narrowly scoped, short-lived credentials;
those credentials and network paths never become available to the unattended
container or a retry. Record the approved result without secrets, then remove
that supervised capability. This procedure is specified, not live-tested: no
real side-effect action was authorized for this investigation. It cannot be
counted as verification of a safe live-service workflow.

## Acceptance and next steps

| A2 criterion                                | Evidence/status                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Actual environment inspection               | Development observations plus offline, worktree/process and service-worker runtime exports reviewed.               |
| Host-backed worktree, Ubuntu/VS Code access | Host/container worktree test passed; user confirmed VS Code editing/diff.                                          |
| Enforceable representative boundary         | Offline profile, whole-container termination, approved gateways and direct bypass denials passed.                  |
| Adversarial denials                         | 23 offline checks and 45 service-worker checks passed; no live external mutation was attempted.                    |
| Representative snapshot/source protection   | PostgreSQL 18.6/pgvector 0.8.7 snapshot, non-superuser restore, migration/reset/rollback and SQL shadow DB passed. |
| Attachments/external writes isolated        | Read-only synthetic attachments and mock-service state remained unchanged by worker/retry operations.              |
| Separate supervised side-effect path        | One authorized mock action succeeded; worker/retry route denied and capability absent.                             |
| Decision and limits                         | GO for this representative profile; shared devcontainer stays NO-GO, Vela remains unverified.                      |

Before unattended #4/#5 operations, production code must pin/verify this profile,
record exact ownership and refuse mismatched or incomplete readiness. Feasibility
probes do not enable a runner or authorize new target resources. #1/#2/#3 now
permit implementation of #4. Vela integration, real-data approval and live-service
checks remain #9; no such access is required for representative tool development.
