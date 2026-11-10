# Code Foundry

Local-first AI development automation using OpenCode and local Ollama models.
This repository contains development tooling and a persistent approved-ticket CLI.
No background worker or integrated agent execution is enabled.

## Development container

On Linux, install Docker Engine, VS Code and the **Dev Containers** extension
(`ms-vscode-remote.remote-containers`). Open this repository in VS Code, then run
**Dev Containers: Reopen in Container** from the command palette. The first build
downloads the image and tools; creation runs `yarn install --immutable`.

The Dockerfile uses [Node.js 26 LTS](https://nodejs.org/en/about/previous-releases)
on Debian Bookworm, with Git, GitHub CLI, Python and build-essential for native
Node addons such as SQLite bindings. Corepack and Yarn are pinned; dependency
versions are recorded in `yarn.lock`. The base image follows Node 26 patch
updates; rebuild to receive updates.

Development runs as the non-root `node` user, with its UID adjusted by Dev
Containers for Linux workspace ownership. Named volumes retain Yarn downloads
and node-gyp headers across rebuilds. Dependencies stay in the ignored workspace
`node_modules` directory. No extra services, Docker socket, privileged mode,
host credential directories or other repositories are configured as mounts.

VS Code supplies ESLint, Prettier and Vitest extensions. Press F5 to debug the
TypeScript CLI; edit the launch configuration's arguments as needed.

### Git identity and GitHub authentication

Dev Containers copies your local Git configuration into the container. Set your
identity on the host before opening it, and verify inside with
`git config user.name` and `git config user.email`. Do not put personal identity
values into repository configuration.

Inside the container, run `gh auth login --hostname github.com --git-protocol https --web`,
then `gh auth status`. If you want Git over HTTPS to use this login, run
`gh auth setup-git`. An existing SSH origin can instead use an HTTPS URL with
individual Git commands; no remote change is required for development.
Credentials stay in the container user's GitHub CLI configuration, outside the
repository and image. Authenticate again after recreating the container. VS Code
may also forward a host credential helper or SSH agent according to your own
Dev Containers settings; this project adds no credential mounts.

### OpenCode and host Ollama

The container maps `host.docker.internal` to Docker's host gateway and sets
`OLLAMA_HOST=http://host.docker.internal:11434`. The image installs OpenCode
1.19.5; it starts no OpenCode service, Ollama server or model download.
See the [supervised OpenCode/Ollama operating guide](docs/opencode-ollama.md)
for configuration, reproducible scratch experiments and observed limitations.

An Ollama server bound only to host loopback will not be reachable through the
Docker bridge. When integration work begins, configure its listen address and
host firewall to permit the development container's network only. Do not expose
an unauthenticated Ollama endpoint to untrusted networks. To check connectivity
once configured, run `curl --fail "$OLLAMA_HOST/api/tags"` in the container.

Use a bounded read-only probe for a quick connection check:

```sh
getent hosts host.docker.internal
curl --noproxy '*' --connect-timeout 5 --max-time 10 --fail "$OLLAMA_HOST/api/version"
```

If this succeeds, no host networking changes are necessary. A failure requires
checking the host service, listen address and firewall before changing anything;
the gateway mapping alone does not make a loopback-only service reachable.

### Persistence and manual verification

A normal stop/start preserves the container user configuration. Recreating the
container can discard user configuration under `/home/node`, including GitHub
CLI login and container-local Git settings. Host-forwarded credentials depend on
VS Code and the host session. Never copy credentials into this repository.
The bind-mounted checkout (including `node_modules`) and the two named cache
volumes survive recreation, provided the checkout and volumes are retained.
The node-gyp cache is only populated when native addons need it.

To verify a rebuild without deleting volumes:

1. Save files and note `git status --short`. Keep any uncommitted bootstrap files:
   a fresh clone cannot reproduce files that have not been committed.
2. Use **Dev Containers: Reopen Folder Locally**, then **Reopen in Container** to
   check reconnection. For a true stop/start, stop the development container from
   the host using Docker, then reopen it. Check dependency and login persistence.
3. Run **Dev Containers: Rebuild Container**. Do not remove the named volumes.
   Confirm the post-create immutable install succeeds.
4. Inside the rebuilt container, run `id`, `test -w .`, `yarn install --immutable`,
   `yarn check`, `yarn start --version`, `gh auth status` and the Ollama probe above.
   Use `findmnt -T /home/node/.cache/yarn` and
   `findmnt -T /home/node/.cache/node-gyp` to confirm the retained volume mounts.
5. Confirm that the pre-rebuild changes remain present with `git status --short`.

For VS Code, select **TypeScript: Select TypeScript Version → Use Workspace
Version**. Set a breakpoint in `src/cli.ts` and press F5; confirm it stops and
prints help after continuing. In Testing, confirm all three CLI tests appear,
then run and debug a test. Check formatting on save and ESLint diagnostics in a
TypeScript file, undoing any temporary edits. Extension installation can be
verified from the container; these UI interactions require a manual check.

For host-level security verification, get the container ID from Dev Containers
logs and run `docker inspect <container-id>` on the host. Inspect
`HostConfig.Privileged`, `HostConfig.CapAdd`, `HostConfig.Binds`, `Mounts` and
`HostConfig.PortBindings`; do not publish the full output, which may include
environment secrets. The project requests no privileged mode, socket mount or
published ports. VS Code can add its own mounts, sockets and credential helpers;
review those separately from repository configuration. Host Ollama firewall
exposure must also be checked on the host; a successful container probe cannot
establish which other clients can connect.

## Commands

Outside the container, install Node.js 26, then install the pinned Corepack with
`npm install --global corepack@0.36.0` and run `corepack enable`.
See [Yarn's installation guide](https://yarnpkg.com/getting-started/install).

```sh
node --version
yarn --version
git --version
gh --version
yarn install --immutable
yarn dev                 # Watch the TypeScript CLI
yarn typecheck
yarn lint
yarn format              # Apply formatting
yarn format:check
yarn test                # Run Vitest once
yarn test:watch
yarn build
yarn start --version     # Run compiled CLI
yarn start --help
yarn check               # Typecheck, lint, formatting, tests and build
```

`src/cli.ts` is the executable entry point; `test/` contains CLI smoke tests.
Build output and source maps go to `dist/`. The package is private and is not
published. The CLI reads its version from `package.json` in both source and build
execution, so keep that file beside `dist/` when running build output.

## Architecture and roadmap

Code Foundry will own scheduling, SQLite persistence, GitHub integration,
permissions, Git worktrees, deterministic validation, retries, recovery and
approvals through a CLI and background worker. OpenCode owns code implementation,
tools, skills, model selection, agent sessions and context management. GitHub is
authoritative for specifications, milestones and dependencies. Initial reviews
are independent manual reviews using ChatGPT/Codex or Claude.

The [approved-ticket CLI guide](docs/queue.md) covers project/profile configuration,
explicit approval, GitHub issue intake, SQLite state, inspection and manual claims.
State uses Node 26's built-in SQLite driver. Claims persist across restart; the CLI
does not launch an agent or implement unattended recovery.

[GitHub issues](https://github.com/aarondewindt/code-foundry/issues) are the detailed
roadmap. [A1](docs/opencode-ollama.md) records supervised representative OpenCode
worktree, skill, coding and continuation evidence with independent review.
[A2](docs/execution-isolation.md) verified a restricted representative worker
profile: filesystem/credential/network restrictions, service gateways, host
worktrees, whole-container termination, PostgreSQL 18/pgvector and a real local
OpenCode trial passed. The shared development container remains **NO-GO** for
unattended agents. B2/B3 must implement the demonstrated controls and fail-closed
readiness before execution is enabled. See the
[A2 host procedure](docs/experiments/a2/host-procedure.md) for evidence and limits;
no repeat host check is currently needed for this exact profile. Imported host
exports belong under ignored `scratch/`; lint/format checks exclude them and
Vitest discovers only repository tests under `test/`.

Queue work in #3 is independent of A2. Environment preparation #4 requires #2/#3;
execution #5 follows #4. Recovery #6 and review handoffs #7 feed representative
end-to-end acceptance/cleanup #10. Vela integration #9 follows milestone B and can
run alongside C1; final Vela unattended acceptance remains #8.

Code Foundry development stays separate from Vela. A future pinned build can run
as a trusted supervisor inside Vela's devcontainer with restricted task workers;
Vela deployment-specific permissions and safety checks belong to #9. This shared
development container is **not a security sandbox for unattended agents**. No Vela
mounts, background worker, GitHub mutations, automatic pushes, merges or deployments
are included.
