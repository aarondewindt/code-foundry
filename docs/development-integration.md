# Disposable development integration tests

Normal development stays inside the unprivileged Code Foundry devcontainer.
`yarn check` needs neither Docker nor a VM. `yarn test:integration:smoke` launches
a disposable Ubuntu VM using QEMU software emulation; Docker runs only inside
that guest. `yarn test:integration` additionally runs the real environment manager
against two synthetic task environments. Neither command starts OpenCode.

[Issue #2](https://github.com/aarondewindt/code-foundry/issues/2) owns the safety
boundary and [#4](https://github.com/aarondewindt/code-foundry/issues/4) owns
environment acceptance. Guest results do not attest the actual Ubuntu host, close
the B2 acceptance gap, or establish Vela compatibility. Historical A2/B2 evidence
is unchanged. Runtime restrictions and approved image IDs are unchanged.

## First use

Rebuild the Code Foundry devcontainer to obtain QEMU, cloud-image-utils, the SSH
client and standalone ripgrep. No privileged mode, extra capabilities, Docker
socket, host devices or additional mounts are needed. The launcher refuses root.

```sh
yarn install --immutable
yarn check
yarn test:integration:smoke
```

The smoke needs no existing Docker images, model, credentials or host commands.
It downloads the checksum-pinned Ubuntu cloud image in
`tools/integration/artifacts.json`. Checksums were obtained from the official
[Ubuntu release checksums](https://cloud-images.ubuntu.com/releases/noble/release-20261017/SHA256SUMS)
and [Node checksums](https://nodejs.org/dist/v26.13.0/SHASUMS256.txt).
Cached artifacts are verified on reuse; a changed upstream file fails closed.

During guest setup, cloud-init installs Docker, AppArmor and BusyBox from Ubuntu's
signed apt repositories. A fixed QEMU guestfwd helper permits GET requests only to
the public archive/security Ubuntu package hosts. It rejects private DNS results,
credentials, CONNECT and redirects. No generic proxy or host listening port is
provided. A private per-run marker disables the helper before tests start.
Package versions come from current signed Noble repositories; the report records
the resulting Docker/kernel versions. This is not a fully pinned package mirror.

Full integration exposes only the explicitly supplied image archive as an
additional read-only virtual disk. Docker loads it directly inside the guest,
avoiding SSH encryption of the large archive under software emulation. It is
not a host filesystem mount or a connection to the host Docker Engine.

Guest networking uses `restrict=on`, IPv6 disabled and one management SSH forward
bound to devcontainer loopback. No host filesystems, repositories, credential
directories, GPU/KVM devices, Docker sockets or existing databases are shared.
Per-run SSH user and host keys are generated locally; host-key verification is
strict. SSH config, agent forwarding and developer credential inheritance are
disabled. The test workers never receive management keys or Docker authority.

## Smoke verification

The smoke imports a tiny guest-local BusyBox root filesystem into Docker, without
pulling a registry image. It records its checksum and image ID, then verifies:

- Enforced `docker-default` AppArmor, seccomp, no-new-privileges and zero capabilities.
- Actual cgroup v2 memory/CPU/PID limits, matching the existing worker values.
- Read-only root and synthetic attachment mounts, a writable task bind mount and
  a network namespace containing only loopback.
- Parent and child writers both cease after whole-container termination.

It removes its exact containers and imported image. The outer VM teardown is the
backstop for errors or an interrupted Docker client. A smoke pass is runtime
compatibility evidence, not environment-manager or real-model acceptance.

An initial single-threaded live smoke passed in 343.73 seconds inside the current
unprivileged devcontainer, using locally extracted Debian QEMU 7.2 tooling because
the running container predates the Dockerfile update. A repeat after rebuilding
the devcontainer passed in 370.43 seconds using the installed QEMU 7.2.22, guest
Docker 29.1.3 and kernel 6.8.0-147-generic. All twelve smoke checks passed, and
VM termination and writable-disk removal were verified. The repeat report is
`scratch/integration-dta6yggv/report.json`.

The full environment suite subsequently passed in 1,027.64 seconds with the
operator-supplied approved-image archive and the lower-memory profile below.
Both environments became ready, gateway substitution was denied for each,
SQLite reopen/readiness checks passed, and no forbidden request reached the
synthetic model upstream. The VM stopped; its diagnostic disk was removed after
review. The compact evidence is in
[results.json](experiments/development-integration/results.json), with the full
private report at `scratch/integration-tz_6id_p/report.json`.

## Full environment integration

The existing approved worker/database images must be supplied once as a Docker
save archive. Their immutable IDs live in `src/environment/runtime.ts`. Obtain
the archive through an explicitly authorized export of those images; this harness
never connects to the host Docker Engine or discovers/exports host resources.
Keep it outside tracked files, for example under ignored `scratch/`.

```sh
CF_INTEGRATION_IMAGES=/absolute/path/reviewed-images.tar yarn test:integration
CF_INTEGRATION_IMAGES=/absolute/path/reviewed-images.tar yarn check:integration
```

Alternatively pass `--images /absolute/path/reviewed-images.tar`. Missing images
are an error, not a skipped test. Loading an archive never changes the reviewed
pins. Rebuilding the existing recipes does not guarantee identical image IDs;
candidate image selection still needs separate review. No candidate build or
automatic image approval is added by this harness.

The launcher transfers only source/test/runtime inputs, package/lock files and
installed dependencies into the guest, excluding Git configuration, hidden files,
state, credential files, scratch exports and symlinks escaping the checkout.
It uses checksum-pinned Node 26 and the dependencies installed with the pinned
Yarn's immutable install. The supervisor runs inside the guest, keeping Git bind
paths, `/proc` process identities and Unix sockets on the Docker daemon's machine.
No remote Docker path translation or production endpoint configuration is added.

The shared fixture prepares two real Git/PostgreSQL 18/pgvector environments,
checks independent storage, dirty-source/attachment preservation, real restricted
worker readiness, gateway/database denials and migrations, then reopens SQLite
and reruns readiness. A powerless synthetic model-list service on guest loopback
11434 exercises the production gateway's fixed destination. It records forbidden
upstream requests and requires there to be none. It never connects to real Ollama.

## Budgets, evidence and cleanup

The VM has two vCPUs, 3 GiB RAM, a 64 MiB translation cache and a disposable
24 GiB virtual disk. These development VM budgets reduce pressure on the editor's
host; worker cgroup limits remain unchanged. Software
emulation is slower than native execution; first-use package installation also
costs time. The default guest lifetime is 1,800 seconds, independently enforced by
GNU timeout even if the controller crashes. `--timeout` accepts 60–3,600 seconds.
Boot, package setup, smoke, Docker calls and environment integration have separate
finite deadlines. These do not relax the worker's existing security/resource
profile. Downloads are separately size/time bounded and caches are checksum keyed.

QEMU uses one translation thread and two guest vCPUs, with five-level page tables
disabled (`max,la57=off`). QEMU documents a TCG/LA57 fault in
[issue 1023](https://gitlab.com/qemu-project/qemu/-/work_items/1023).
The full suite passed with these settings; this does not establish the cause of
the observed panics or long-term emulator stability. An earlier single-threaded
two-vCPU full integration trial with `max` instead of `max,la57=off`
also panicked in `__kmalloc` while `runc` ran; smoke success alone does not prove
full environment compatibility. The initial live
multi-threaded TCG trial booted and installed Docker, then the guest panicked in
`nf_conntrack` with an INT3 exception. Single-threaded translation avoids parallel
translation as a conservative compatibility choice; this does not establish the
cause of that panic or change worker isolation. QEMU tracks a related
[multi-threaded stale-code issue](https://gitlab.com/qemu-project/qemu/-/work_items/4669).

The launcher prints a private `scratch/integration-*` report directory. Reports
include elapsed time, scope, artifact identities, guest checks and cleanup status.
Stage progress is saved before boot, bootstrap, smoke, image loading, source
transfer and environment checks. An interrupted report is not success evidence.
Failed commands retain bounded private SSH diagnostics in `failure.stderr`.
Only known JSON reports are exported from the guest, not passwords, SQLite state,
database dumps or sockets. Console/QEMU logs remain private diagnostic files.
Each exported report and the QEMU console log is bounded to 2 MiB. Excess console
output is drained and discarded; oversized SSH output fails instead of filling
the devcontainer's disk or memory. Image archives are limited to 8 GiB and the
source/dependency snapshot to 1 GiB.

On success, failure, SIGINT or SIGTERM, the controller stops its owned VM process
group and verifies termination before removing the writable disk. Reports remain.
`vm-identity.json` records the timer process/group and Linux start ticks for manual
diagnosis after a controller crash; the launcher never kills from a stale PID file.
`--keep-artifacts` retains a **stopped** guest disk for diagnosis; services do not
keep running. If termination cannot be verified, cleanup fails and the disk is
retained. A SIGKILL/power loss can leave files behind; the independent VM deadline
bounds guest execution, and stale run directories are never automatically deleted
or treated as ownership of a running process.

The environment manager still retains task resources on preparation failure.
Discarding an explicitly disposable test VM afterward is fixture teardown, not
the production cleanup feature reserved for #10. Existing retained host fixtures
are never inspected or deleted by this harness.

## Remaining host acceptance

`CF_HOST_VERIFY=disposable-synthetic-only node --import tsx test/environment-host.ts`
remains explicitly opt-in and retains its host services/resources. Real-model
and candidate-image host helpers remain separate. Ordinary integration testing
does not invoke them.

Occasional host verification remains necessary for the actual devcontainer's
privileges/mounts/credential forwarding, host/VS Code task-path editing, real
devcontainer recreation and UI behavior, host Ollama firewall exposure/GPU use,
and deployment-specific worker enforcement. Vela access remains separately scoped
under #9. Do not substitute guest results for those checks.
