# Task environment preparation

[Issue #4](https://github.com/aarondewindt/code-foundry/issues/4) is authoritative.
The implementation adds synchronous environment preparation to the B1 CLI. It
starts a synthetic database service and bounded readiness probes; it never starts
OpenCode or executes project hooks. **Automated two-environment host integration
has passed. Manual Ubuntu VS Code and inspection-devcontainer acceptance remains
pending before #4 is complete or #5 begins.** The reviewed B2 evidence is retained
in [the host review](experiments/b2-host-results/review.json); A2's earlier exports
remain separate feasibility evidence.

## Layout and lifecycle

`prepare` refreshes GitHub through B1, verifies the approved specification and
blockers, and obtains the existing exclusive attempt claim. SQLite schema 2 adds
an environment row keyed to that task and attempt. Resource names and an opaque
ownership UUID are recorded before provisioning. Stage events, a supervisor-only
manifest and SQLite survive interruption. An existing reservation refuses replay.

Each existing canonical project `taskRoot` contains UUID directories with:

- `store.git` and `worktree`: independent Git storage and a local task branch.
- `home`, `cache`, `build`, `uploads`: private writable outputs.
- `environment.json`: effective configuration, paths and namespace-local ports.
- `database.json`: generated task-role credentials for the narrowly mapped gateway.

Supervisor files live alongside SQLite in `environments/<owner>/`, outside every
worker mount. `manifest.json` uses private files, atomic rename and fsync; SQLite
is authoritative. The sibling database control and gateway directories are
writable by the different database UID, but their private parent is never mounted
into a worker. The worker gets only the gateway directory read-only. Never put
SQLite, its sidecars, supervisor manifests, dumps or service logs inside a task.
The state directory must be private to the trusted supervisor.

A ready preparation finishes its reservation with outcome `environment-ready`
and returns the task to B1's `queued` state. The separate environment remains
`ready`; no coding attempt has run. This allows a second preparation. Inspect the
environment rather than inferring readiness from queue status. Approval changes
are refused once an environment is retained. Future #5 must obtain a fresh B1
execution claim and recheck the retained environment before launching anything.

Failure preserves the active attempt, stage, resources and diagnostics. Use
`environment-owner` to retrieve its recovery token in the trusted supervisor
terminal; never share this output with a worker. `recover-environment` verifies
the token and rechecks existing resources before completing a preparation that
already provisioned successfully. It never repeats clone/restore operations or
creates replacement resources. An incomplete cluster requires manual diagnosis;
there is no automatic repair, deletion, reset or cleanup. In particular, a failed
initialization with an existing data directory and no completion marker refuses
restart instead of guessing whether the restore committed.

## Git and host paths

The supervisor resolves and records `HEAD^{commit}`. It uses `git clone --bare
--no-local --no-hardlinks`, removes the clone's origin and creates a worktree/local
branch in that independent store. The original checkout is only read. No source
branch switch, reset, stash, clean, hook or build command runs. Tracked source
content at the recorded commit is used; dirty/untracked source files stay intact.
Git runs without developer global/system config or inherited Git/SSH variables.

Readiness checks the common directory, both worktree pointers, branch/base,
canonical paths and metadata files, refusing symlinks, hard links and alternates.
Root device/inode is retained as filesystem ownership evidence. A UUID path or
name prefix alone is insufficient.

Use an absolute host path such as `/srv/code-foundry/tasks`. Preparation currently
runs as the non-root Ubuntu supervisor with existing Linux Docker access. Mount
each task's exact absolute root at the same absolute path in any development
container used to inspect it. Mount only that task root into its worker. Opening
`code --new-window <worktree>` on Ubuntu needs no path translation. Automatic
VS Code launching and development-container reconfiguration are not implemented;
manual editing/diff verification remains part of host acceptance. Disable personal
credential forwarding when inspecting task containers, and confirm no worker is
running before human edits.

## Synthetic database service

This version only initializes a new, disposable synthetic cluster for each task.
It cannot accept an existing database URL or source credentials. Synthetic source,
target and shadow databases are scoped by the exact backend container and volume,
so their SQL names can repeat safely across tasks. A constrained source project
must carry `.code-foundry-synthetic` containing `code-foundry-synthetic-v1` and a
newline. This is an operational guard for representative fixtures, not proof that
arbitrary marked private data is safe to copy.

The pinned database image contains PostgreSQL 18, vector 0.8.7 and PgBouncer.
The backend has no network and runs as UID 999, different from the supervisor and
worker. Cluster files, passwords and the complete custom-format dump remain in a
retained labeled volume. It uses SCRAM authentication and no TCP listener.

The supervisor seeds invented rows/embedded tokens, a vector/HNSW index, view,
sequence and large object. A full `pg_dump -Fc` supplies a consistent logical
snapshot. There are no schema/table/data filters. Sequences retain PostgreSQL's
normal nontransactional semantics. Restore runs transactionally as the restricted
task login, without source owners/ACLs. Only vector extension creation and its
comment are excluded from the restore list because the supervisor installs that
non-trusted extension first. Shadow DB creation also belongs to the supervisor.

Source/clone inventories include row contents, vectors, index definitions, schema
objects, sequence state, view rows and large-object contents. Persistent evidence
includes database OIDs, owner OIDs and role OID. Before migrations/readiness,
checks verify ownership and absence of privileged flags/role memberships. Fixture
migrations on both target and shadow run inside rolled-back transactions. Readiness
rechecks the live source inventory and exact recorded OIDs. No reset CLI exists.

PgBouncer explicitly maps only task/shadow database names to the task role. Source,
default, other-task, alternate-user and console connections must fail through the
worker gateway, including when PUBLIC would permit a raw source connection.
Source/admin credentials, backend sockets and volume files never enter workers.
Embedded tokens are intentionally synthetic and powerless; network/gateway rules
prevent their use to call protected routes. Nothing here sanitizes real sensitive
copies or establishes Vela compatibility; those remain #9.

## Runtime preflight

Only the local immutable worker/database IDs in `reviewedImages` in
`src/environment/runtime.ts` are accepted. The database uses A2's reviewed image;
the worker uses the reviewed B2 derivative with standalone ripgrep. Images are never
pulled or rebuilt by preparation. If the host no longer has them, stop and arrange
a separately reviewed image build; changing a tag or accepting an arbitrary image
ID is not a fallback.

Containers explicitly request `apparmor=docker-default`. Creation checks verify
that request and all configured restrictions; Docker may leave the active
`AppArmorProfile` field empty while the container is still `created`. After startup,
inspection must report `docker-default`, and the worker verifies its own enforced
profile through `/proc/self/attr/current`. An empty or unconfined runtime profile
fails readiness.

The second reviewed host run, `scratch/cf-b2-host-hvKz7l`, successfully provisioned
PostgreSQL 18.6/vector 0.8.7 with matching source/clone inventories. Its worker
passed AppArmor, privilege and cgroup checks, then failed the composite search-tool
check. The A2 image recipes do not explicitly install standalone ripgrep. Search
readiness now distinguishes missing executable, execution failure and worktree
search failure; it remains mandatory.

To diagnose that image and build a retained candidate only when `rg` is absent:

```sh
node --import tsx test/worker-image-host.ts --build-candidate
```

This host-only helper uses the immutable reviewed base. If a build is needed,
`runtime/environment/worker.Dockerfile` installs ripgrep inside a derived image;
it does not install host packages or change host security settings. Restricted
synthetic probes test the original/candidate image, and the helper retains the
build log, image ID, recipe/helper hashes, probe outputs and stopped containers in
the printed `/tmp/cf-b2-worker-image-*` folder. Copy that folder to `scratch/` for
review. It never replaces `reviewedImages.worker` or selects an unreviewed image.
If `rg` already exists, it records its exit codes and does not build a replacement.
Candidate search success alone is not B2 acceptance; after reviewing the new
immutable ID, update the pin deliberately and rerun full environment verification.

The reviewed [search-image export](experiments/b2-worker-image/review.json) confirms
that the original image lacks standalone `rg` and that the derived image passes
version, file-list and content-search checks with ripgrep 13.0.0. Both build-source
hashes matched at review. Installing `rg` on Ubuntu does not supply it inside an
isolated worker image. The operator confirmed the candidate container's runtime
image ID matches the exported build reference, with exit code 0 and AppArmor
`docker-default`. That exact image is now selected in `reviewedImages.worker`.
The build log's separate config digest is retained as provenance, not substituted
for the observed runtime ID. The helper now captures image/container identities
separately. Full B2 integration remains pending; rerun the two-environment host
script with this pin and retain all earlier failed environments.

The runtime inspects actual container image/ID/ownership, user, private network,
PID/IPC/cgroup namespaces, read-only root, capability drop, no-new-privileges,
AppArmor, finite CPU/memory/PID limits, exact mounts and absence of published ports,
devices or unexpected storage. Actual worker probes check seccomp, privileges,
cgroup limits, search tools, matching Git paths, credential absence, network denial,
read-only attachment mutation denial, database access and forbidden gateway routes.
Only the task root is writable. No Docker socket, SSH forwarding, source repository,
sibling task, supervisor control, backend socket or shared cache is mounted.

Ports 3000/4111 are private to each worker's network namespace, checked by binding
inside the probe. SQL uses a Unix socket at port 6432. No host ports are reserved
or published, so tasks cannot collide through host port allocation. #5 must supply
its own bounded adapter at 4111 when it starts OpenCode.

The supervisor model gateway is a foreground process using the A2-reviewed fixed
loopback forwarding policy, extracted into `runtime/environment/model_gateway.py`.
Its model-list readiness checks the live fixed upstream for the approved model,
so a missing Ollama/model fails preparation. It permits only the approved model/chat route, with bounded concurrency, framing,
request count, response size and deadlines; model management and arbitrary proxy
routes are denied. It writes a private sibling manifest containing code hash,
process start identity and socket inode/device. Preparation binds this evidence
to one task; a different task cannot reuse it. A process/socket replacement fails
readiness. No generic service manager or daemon is installed. Keep the gateway
alive during checks. It never inherits an arbitrary upstream destination from
request data and connects only to supervisor loopback port 11434.

Worker probes are identified and persisted before start. A finally block stops
the whole container and verifies it stopped, even if its client times out. No
container, volume or worktree is removed. Database/gateway service restarts are
manual; subsequent readiness must succeed against the same ownership identities.

## CLI operation on the host

Build with Node 26 and the pinned Yarn. Preserve `runtime/` next to `dist/` when
using the compiled CLI. Start with the [B1 project configuration](queue.md), using
an existing canonical task directory and private SQLite directory.

For each task, create a dedicated empty model socket directory outside task and
source roots, then keep this supervisor command running in a separate terminal:

```sh
python3 runtime/environment/model_gateway.py /absolute/model-sockets/task-a gpt-oss:20b
```

It creates `task-a/ollama.sock` and private `task-a.gateway.json` beside that
directory. Each task needs its own gateway. Use a synthetic shared directory with
only a regular `attachment.txt` containing `synthetic attachment` and a newline.
Create `/absolute/environment-a.json`:

```json
{
  "source": "/absolute/synthetic-project",
  "shared": "/absolute/synthetic-shared",
  "modelGateway": "/absolute/model-sockets/task-a",
  "workerImage": "sha256:612b2be5a3d9d21d79030001f74b89870db1fe0af923847afa88629500a1cafc",
  "databaseImage": "sha256:42f51c32e76023298c26768b79fc32456feb4e49765fcf31b391891d4d7095db"
}
```

Enqueue only an explicitly approved real GitHub issue using B1, then:

```sh
node dist/cli.js prepare <task-id> --environment-config /absolute/environment-a.json --db /private/state.sqlite
node dist/cli.js environment <task-id> --db /private/state.sqlite
node dist/cli.js readiness <task-id> --db /private/state.sqlite
node dist/cli.js events <task-id> --db /private/state.sqlite
code --new-window <worktree-path-from-environment>
```

A successful readiness response has this shape (illustrative, not live evidence):

```json
{ "ready": true, "worktree": "/srv/code-foundry/tasks/<owner>/worktree" }
```

For failure diagnosis, inspect `stage`, `error`, resource IDs and the private
manifest. Use `docker logs <exact-owned-container-id>` locally to diagnose snapshot,
SQL or worker-probe failures. Do not publish unfiltered service logs/inspect data.
A missing runtime/image fails at `security-preflight`; path/metadata failures at
`git`; snapshot/restore failures at `database`; mount/port/gateway/probe failures at
`worker-readiness`. No service error output is copied into SQLite/events.

To finish an interrupted preparation whose resources are already complete:

```sh
node dist/cli.js environment-owner <task-id> --db /private/state.sqlite
node dist/cli.js recover-environment <task-id> --attempt <attempt-id> --token <token> --db /private/state.sqlite
```

Recovery will refuse incomplete resources, changed identities/profile or failed
live checks. Do not release a failed claim using B1's manual transition while a
container might still be running. Inspect/stop the exact owned probe first; this
implementation does not perform automatic takeover or grant cleanup authority.

## Verification and handoff

Local automated tests use real temporary Git repositories, dirty source files,
two independent stores, metadata-tampering attempts, SQLite restart/failure tests,
adversarial runtime-inspection fixtures and real Unix model-gateway connections to
a protected synthetic HTTP upstream. Database failures are deterministic fixtures,
not evidence of a successful PostgreSQL restore.

Run the real integration on an Ubuntu host that already has the reviewed images
and existing Docker access:

```sh
yarn install --immutable
yarn check
CF_HOST_VERIFY=disposable-synthetic-only node --import tsx test/environment-host.ts
```

This opt-in script creates two synthetic approved test records (it does not fetch
or mutate GitHub), a disposable source Git repository, separate model gateways,
two complete environments and private reports. It checks sequential preparation,
independent Git/DB identities, migrations/source inventory, unchanged dirty source
and shared attachment, persistence after reopening SQLite and live readiness.
It retains every service/resource and prints the root for inspection. An initial
missing Docker preflight exits before creating fixtures. Review `report.json`,
private manifests and actual Docker identities; open both worktrees in Ubuntu
VS Code and an inspection devcontainer with identical paths. Record that manual
result separately. Cleanup remains explicitly authorized later work.

The successful operator export `scratch/cf-b2-host-HO7o9y` prepared two environments
using PostgreSQL 18.6/vector 0.8.7 and the updated worker image. Both completed
readiness, rolled-back fixture migrations and repeated worker checks after SQLite
reopen. Local review matched the runtime profile to current source, compared
SQLite/manifests, validated copied Git pointers and independent edits, and checked
source/clone inventories plus unchanged synthetic source/attachment bytes. See the
[retained review](experiments/b2-host-results/review.json) for exact evidence,
resource identities and limits. The original failed attempts remain retained.

These are reviewed operator exports, not a live Docker inspection from this
container. The current script reopens SQLite and restarts worker probes; it does
not restart PostgreSQL or the Docker daemon. Its route-denial checks are additional
to local protected-mock gateway tests and earlier A2 service-state evidence; it
does not contain a new separate host mock-state counter. No OpenCode/Vela acceptance
is implied.

The remaining manual check is opening the prepared worktrees in Ubuntu VS Code
and an inspection development container using identical absolute paths, then
verifying task-only editing/diff visibility. Record that result separately; no
additional automated run is required for this reviewed profile. #5 still needs
bounded OpenCode launch/session handling and validation; #9 needs real project
migrations, existing-cluster safeguards and separately approved private-data
integration.
