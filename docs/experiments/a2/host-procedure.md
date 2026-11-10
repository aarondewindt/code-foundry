# A2 host verification and deferred Vela procedures

These procedures are reviewable follow-ups to the
[isolation report](../../execution-isolation.md). The initial offline Docker probe passed in the
operator-provided export; the service-enabled representative trial also passed.
Existing-cluster steps remain **not run**. Do not infer permission to change host
security/network settings, mount private data, use production credentials or
connect to Vela's database from this document.

## Service-enabled trial (passed; reproduction)

The offline export passed all 23 checks. The follow-up export
`scratch/code-foundry-a2-followup-w0xaobpf` passed host/container worktree paths,
whole-container termination and PostgreSQL 18.6/pgvector 0.8.7 snapshot/migration/
shadow-database checks. All four probe-source hashes match. The user confirmed
VS Code editing/diff visibility separately from the unchanged automated results.
Reviews and copies are in [host-offline](host-offline/review.json) and
[host-followup-results](host-followup-results/review.json). Do not rerun those
completed checks for these same profiles/images.

The service export `scratch/code-foundry-a2-services-858i4416` also passed all
45 worker, 8 host and 2 retry checks. Its six probe-source hashes match. Reviewed
copies are in [host-services-results](host-services-results/review.json). All three
containers exited successfully and no cleanup error was reported. There is no
further A2 host step for the tested profile; the command below is for reproduction.

A directory-copy warning for `ollama.sock` is expected: Unix socket nodes are
runtime IPC endpoints, not results. Skip them; the JSON files, hashes, validation
and logs carry the evidence. Do not recreate/reconnect the socket or rerun a passed
trial just to copy it. Generated task credentials and SQLite/session state do not
need to enter repository evidence.

On the same Ubuntu host, from this checkout:

```sh
python3 docs/experiments/a2/services/host_services.py scratch/code-foundry-a2-followup-w0xaobpf
```

The argument may instead name the original follow-up directory. The two previous
immutable base images must still be present in the same Docker engine. The script
records unique local aliases for the verified base images (without replacing
existing tags), builds two derived fixture images with PostgreSQL client/PgBouncer
tools, then:

1. Starts a fresh offline PostgreSQL 18 service with only task/shadow database
   aliases at its Unix PgBouncer frontend. Its backend socket, admin credentials,
   control files and source DB are absent from the worker. The worker UID must
   differ from the PgBouncer UID, since its special peer-authenticated console
   identity otherwise bypasses ordinary password authentication; the harness
   refuses equal UIDs. See [PgBouncer admin access](https://www.pgbouncer.org/usage.html#admin-console).
2. Starts a host Unix HTTP gateway with the fixed upstream
   `http://127.0.0.1:11434/v1/chat/completions`, allowing only `gpt-oss:20b`
   inference plus a synthetic model-list response. An adapter inside the offline
   worker exposes that single socket as loopback HTTP for OpenCode. It cannot
   forward arbitrary URLs, redirects, models or model-management routes.
3. Checks positive task/shadow SQL migrations and rollback/reset, then denies
   source/default/other-task DBs, alternate users, console access, role elevation,
   server programs and direct TCP/socket bypasses. Rechecks IPv4/IPv6 denial and
   attachment write/delete/chmod denial while gateways are mounted.
4. Performs one token-authorized synthetic side effect in a separate supervised
   process against a host loopback mock. It proves the worker and a fresh retry
   cannot access that route or change the mock's state. No real integration is
   called, and the one-use mock capability is never provided to a worker.
5. Runs an explicitly supervised, bounded real OpenCode implementation of the
   tiny clamp fixture through the existing local model, then independently runs
   its tests. No queue worker or unattended scheduler is installed.

Use the existing local Ollama service/model; this script does not start a model
server, download a model or change firewall settings. A missing service/model or
unrecognized API shape is a failed test, with no fallback. All Docker task/service
containers have no network; only the trusted host gateway contacts the fixed
loopback model endpoint. The model gateway bounds connections (four handlers),
inference concurrency (one), requests (32), bodies (128 KiB), responses (8 MiB)
and upstream time (120 seconds). The worker has a 300-second outer deadline;
OpenCode has a 240-second deadline. SQL pools and query time are bounded. These
controls cover this fixture's requests, not unrelated Ollama clients or measured
host GPU/VRAM consumption.

Copy the printed `code-foundry-a2-services-*` directory into `scratch` for review.
Important files are `services.json`, `task/worker-results.json`, OpenCode output,
validation results and probe hashes. Retain stderr/build logs on failure. Source
and task data are synthetic; generated task DB credentials in the private export
are valid only for its disposable service, never developer credentials. No
container/image/worktree is deleted automatically. Services are stopped on exit;
no port is published by Docker. The host gateway/mock exist only during the test.

Local checks passed: six adversarial gateway tests, the pinned real OpenCode
transport through a synthetic SSE upstream, and PostgreSQL 15/PgBouncer alias
regression. The Docker/real-model trial subsequently passed on the host with
PostgreSQL 18.6 and PgBouncer 1.26.1. OpenCode reported three glob/ripgrep failures
and recovered using read; preserve this tool limitation without relaxing isolation.
The earlier PostgreSQL 18 SQL tests do not verify a real client library such as
Prisma; Vela-specific migration compatibility is deferred to #9.

## Completed follow-up: reproduction

On Ubuntu, from this checkout, using the same non-root Docker account:

```sh
python3 docs/experiments/a2/host-followup.py scratch/code-foundry-a2-host.TEJj9K
```

The argument can instead be the original host export directory. The earlier
image must still be present in that host Docker engine. This follow-up:

1. Creates a new synthetic source repository and independent task Git metadata;
   mounts only the task at the same absolute host/container path; verifies that
   task edits appear on the host while the source stays unchanged.
2. Starts two synthetic writer processes, verifies both are writing, stops their
   container and verifies neither continues writing afterward.
3. Builds a disposable PostgreSQL 18/pgvector 0.8.7 image and starts a new private
   cluster with no TCP listener or network. Checks full snapshot/restore, vectors
   and an HNSW index, task-only migrations/reset, rollback, a separately provisioned
   shadow database and unchanged synthetic source data. Extension installation
   stays with the synthetic supervisor, not the task role.

The image uses the project's documented
[0.8.7-pg18-bookworm tag](https://github.com/pgvector/pgvector#docker), adds Python
for the probe, and records its resulting immutable local image ID. Only the
image build downloads dependencies; probe containers have no network and publish
no ports. No live database, Vela source, credential forwarding or agent execution
is involved. Existing PUBLIC CONNECT behavior is still reported as a known SQL
limitation; this experiment does not replace database admission at a gateway.
The shadow test uses SQL, not Prisma or other application migration tooling.

The script prints the evidence directory, records probe-source hashes and retains
stopped containers/worktrees for review. Return `followup.json`, `database.json`
and `probe-sha256.json`; retain stderr/build logs if a check fails. Containers
are stopped by immutable ID on timeout/failure. Do not relax restrictions to pass.

After it completes, open the printed task worktree with `code --new-window` on
Ubuntu. Edit the synthetic `fixture.txt`, verify that the task diff reflects the
edit and the source checkout is unchanged, and report that manual result. No
agent remains active during this step. No resource cleanup is automatic.

This follow-up has passed in the reviewed export. It leaves approved-service
gateways/bypass denials, actual OpenCode connectivity in the restricted worker,
and the supervised mock-service path to the next prepared trial.
Existing-cluster/real-service procedures below are deferred to #9.

## Offline restricted-container probe (passed export; reproduction)

Run from the Code Foundry checkout **on Ubuntu**, using an already authorized
host-side Docker supervisor. Do not add Docker access to the development or agent
container. This probe needs an ordinary non-privileged container, no network or
privilege changes to the host. It contains synthetic data only. Build an image
from the reviewed Dockerfile if needed; record the resulting immutable local ID.
No OpenCode/model execution takes place in this probe.

```sh
# Bash, run as the non-root developer with existing Docker access.
set -euo pipefail
test "$(id -u)" -ne 0
a2_repo=$(pwd -P)
a2_fixture=$(mktemp -d /tmp/code-foundry-a2-host.XXXXXX)
a2_uid=$(id -u)
a2_gid=$(id -g)
a2_container="code-foundry-a2-probe-$(basename "$a2_fixture")"
mkdir "$a2_fixture/task" "$a2_fixture/shared"
printf 'synthetic attachment\n' > "$a2_fixture/shared/attachment.txt"
cp "$a2_fixture/shared/attachment.txt" "$a2_fixture/original.txt"
# Optional build: no privileged mode, daemon socket mount or service startup.
docker build --file .devcontainer/Dockerfile --iidfile "$a2_fixture/image-id" .devcontainer
a2_image=$(cat "$a2_fixture/image-id")
docker run --name "$a2_container" --pull=never --init \
  --user "$a2_uid:$a2_gid" \
  --network none --ipc private \
  --read-only --cap-drop ALL --security-opt no-new-privileges=true \
  --cpus 2 --memory 4g --memory-swap 4g --pids-limit 128 \
  --ulimit core=0 \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=256m,mode=1777 \
  --mount "type=bind,source=$a2_fixture/task,target=/task" \
  --mount "type=bind,source=$a2_fixture/shared,target=/shared,readonly,bind-recursive=disabled" \
  --mount "type=bind,source=$a2_repo/docs/experiments/a2/restricted-boundary-probe.py,target=/probe.py,readonly" \
  --workdir /task \
  "$a2_image" python3 /probe.py | tee "$a2_fixture/result.json"
# No complete environment dump: inspect only selected runtime properties.
docker inspect --format 'Privileged={{.HostConfig.Privileged}} ReadonlyRootfs={{.HostConfig.ReadonlyRootfs}} Network={{.HostConfig.NetworkMode}} CapDrop={{json .HostConfig.CapDrop}} SecurityOpt={{json .HostConfig.SecurityOpt}}' "$a2_container"
cmp "$a2_fixture/original.txt" "$a2_fixture/shared/attachment.txt"
```

Expected probe result: every check true and process exit 0; `Privileged=false`,
read-only root, no network and all capabilities dropped. The script checks cgroup
v2 CPU/memory/swap/PID settings as well as actual read/write/delete/chmod/symlink
and IPv4/IPv6 denial. Timeout/refusal to an arbitrary service is not accepted as
proof of namespace denial: the probe requires loopback-only interfaces and
ENETUNREACH/EAFNOSUPPORT/EPERM/EACCES for documentation-only address targets.

If a check fails, retain the stopped container and fixture, record the failure
and stop. Do not retry with privileged mode, relaxed seccomp, host networking,
more mounts or forwarded credentials. Review any version-specific flag/resource
problem as an unresolved preflight. Docker must retain its default seccomp and
an appropriate host LSM policy; those settings also need host-side verification.
No live GitHub writes or privilege escalation are needed to test this profile.

After reviewing results, explicitly remove only the named stopped probe container:

```sh
docker rm "$a2_container"
# Retain result.json for review. Remove the exact printed fixture directory
# manually when no longer needed; do not delete using a wildcard.
printf '%s\n' "$a2_fixture"
```

This is only the **offline** filesystem/process/resource gate. It deliberately
cannot reach Ollama, databases or Home Assistant. Full acceptance additionally
requires verified supervisor-owned Ollama and per-task database gateways,
positive approved-service tests, negative bypass tests (alternate routes,
database/user selection, IPv4/IPv6, arbitrary proxy destinations), and a supervised
OpenCode task inside the same profile. Do not mount the entire host `/run` or a
PostgreSQL admin socket to obtain connectivity.

## Host/container worktree paths and VS Code (passed representative trial)

The synthetic worktree probe ran on the workspace's existing host bind mount,
but Ubuntu access and VS Code were not exercised. For A2, use a synthetic source
and task worktree; repeat these checks for Vela later in #9:

1. Select/approve a host-owned canonical task root outside Vela's normal checkout.
   Prepare an independent bare repository and task branch/worktree from the
   approved base through the trusted supervisor. Do not use shared writable Git
   metadata, object alternates or hardlinks to the normal checkout.
2. Mount **only** that task root into a restricted container at the identical
   absolute path. No normal Vela repository or other task is mounted.
3. From Ubuntu and from the stopped-agent inspection environment, run
   `git -C "$task_worktree" rev-parse --show-toplevel --git-dir --git-common-dir`,
   inspect the `.git` pointer and run `git -C "$task_worktree" status --short`.
   Verify that all resolved metadata remains inside that task's root. Compare the
   base commit and normal checkout status with the supervisor's recorded values.
4. Open the task worktree with `code --new-window "$task_worktree"` on Ubuntu.
   Verify editing a synthetic task file and seeing its diff from both environments,
   then restore only that synthetic file. Do not start Vela or apply migrations.
5. Confirm agent termination before human takeover; do not allow a second agent in
   the same task. Preserve real trial changes until explicit cleanup/review.

The literal paths above are supplied by the supervisor, not by issue text or
repository code. Creating a canonical host alias/mount, if necessary, requires
separate host configuration approval. The current experiment does not authorize
changing Vela's existing metadata or branches.

## Synthetic PostgreSQL reproduction (completed)

This was run in the Code Foundry container as UID 1000. The Debian package indexes
and extracted binaries are private temporary files, not system installations.
No `sudo`, service manager, Docker or live connection string is used. Download
uses existing Debian package sources; no repository/security configuration changes
are needed. The run selected server/client **15.19-0+deb12u1**. If those packages
are no longer available, record the actual version before comparing results;
never substitute this fixture for the required PostgreSQL 18 integration test.

```sh
mkdir -p /tmp/code-foundry-a2-packages/lists/partial \
  /tmp/code-foundry-a2-packages/cache/archives/partial \
  /tmp/code-foundry-a2-packages/root
apt-get -o Dir::State::lists=/tmp/code-foundry-a2-packages/lists \
  -o Dir::Cache=/tmp/code-foundry-a2-packages/cache \
  -o Debug::NoLocking=1 -o APT::Sandbox::User=node update
(cd /tmp/code-foundry-a2-packages && \
  apt-get -o Dir::State::lists=/tmp/code-foundry-a2-packages/lists \
    -o APT::Sandbox::User=node download postgresql-15 postgresql-client-15)
for package in /tmp/code-foundry-a2-packages/postgresql-*.deb; do
  dpkg-deb --extract "$package" /tmp/code-foundry-a2-packages/root
done
A2_PGBIN=/tmp/code-foundry-a2-packages/root/usr/lib/postgresql/15/bin \
  python3 docs/experiments/a2/database-probe.py
```

The script unconditionally creates its **own** new temporary cluster, database
names and passwords. It cannot select an existing server through environment
variables. It performs complete logical dump/restore with an exported snapshot,
target migration, rollback/reset and source-invariance tests. Passwords and rows
are invented; credentials are not printed. Neither the admin fixture connection
nor its filesystem ownership is an example of safely giving a real agent access.
The generated cluster/dump is removed after its server stops. Downloaded packages
remain under the exact temporary package directory for reproducibility; no database
process is retained. Run with compatible installed binaries instead if desired,
recording their version and all limitations.

## Existing-cluster approval plan (not executed)

The current environment has no Vela checkout, database connection details or
approved DB-owner capability. No cluster connections, queries, dumps, migration
commands, live ACL/HBA changes or database/role creation have been attempted.
The repository configuration alone cannot establish the cluster's live state.

The next approval should be for **synthetic resources on the identified existing
PostgreSQL 18 cluster**, not an immediate copy of private data. Review/approve:

1. **Read-only inventory**, by the DB owner: server version; source DB name/OID and
   owner; task-role membership and database/public/schema ACLs; installed extension
   versions; relevant HBA ordering, FDWs, SECURITY DEFINER routines, backup/export
   privileges, active-source workload and resource capacity. Read `pg_roles`, not
   password-bearing auth catalogs; do not publish passwords, connection URIs or
   source rows. Use a read-only transaction with bounded statement/lock timeouts.
2. **Bounded synthetic provisioning**: allocate two fresh DB names and a fresh
   login under an approved unique `cf_a2_<run>` identity, recording exact names,
   OIDs, ownership and expiration outside agent mounts. Refuse pre-existing names.
   Create a tiny synthetic source and clone on that same cluster using the tested
   logical-dump method, matching PostgreSQL 18/pgvector. Keep provisioning and
   migration credentials out of the agent. Do not alter the real source's ACLs,
   settings, connections, extensions or contents.
3. **Isolation tests**: through the proposed per-task gateway, authenticate as the
   task role, verify the task DB works, and verify every other DB (including
   `postgres`, real source, other task DBs), alternate username and direct endpoint
   is denied without querying/writing their data. Confirm Prisma migration and
   any task-only shadow DB cannot select another target. Role flags alone are not
   proof: the local fixture demonstrated inherited PUBLIC CONNECT. Stop if the
   gateway/rules are absent; never temporarily grant broader access to pass.
4. **Cleanup**: the DB owner removes only those recorded synthetic DBs/role after
   validating ownership/OIDs, no active task, preserved results and exact identity.
   Do not terminate unrelated connections or delete by prefix. A failed restore
   retains its identifiable target for operator reconciliation.

This creates shared-cluster catalog entries and may consume storage/CPU/I/O, so
it needs explicit DB-owner approval before execution. Any role-scoped HBA or host
networking change needs its own reviewed approval; it is not covered implicitly
by allowing disposable DB creation. No source database should be made unavailable
to permit a template clone.

Only after that trial and the execution boundary pass should a **separate approval**
cover an actual full source copy: approved source identity, consistent dump window,
privacy assessment (including embedded credentials/sessions), equal-or-stronger
clone/dump access protection, attachment snapshot handling, disk/resource budget,
retention and cleanup. The full logical copy must include all application data;
synthetic data or an undisclosed scrubbed subset is not acceptance of that
requirement. If data cannot be protected, return a blocker rather than weakening
controls or copying it anyway.
