# Supervised OpenCode + Ollama proof of concept

[A1 / issue #1](https://github.com/aarondewindt/code-foundry/issues/1) is the
specification. This guide records the 2026-11-10 scratch experiment and operating
commands, not a task runner. No Vela implementation ticket was approved or run.

## Installation and connection

Tested in the **Code Foundry** devcontainer: Node 26.13.0, Yarn 4.18.1,
OpenCode **1.19.5 (V1)**, GitHub CLI 2.23.0, desktop Ollama 0.40.14.
The Dockerfile now pins OpenCode; its image rebuild has not been tested here.
For the live experiment, installation was isolated outside the repository:

```sh
npm install --prefix /tmp/code-foundry-a1-tools --no-audit --no-fund opencode-ai@1.19.5
/tmp/code-foundry-a1-tools/node_modules/.bin/opencode --version
```

Rebuild the devcontainer to get `opencode` on PATH persistently. No Ollama server
was installed, started or reconfigured, and no models were downloaded.
The existing `OLLAMA_HOST` worked without host-side changes:

```sh
: "${OLLAMA_HOST:?Set the desktop Ollama URL without a trailing slash}"
getent hosts host.docker.internal
curl --noproxy '*' --connect-timeout 5 --max-time 10 --fail "$OLLAMA_HOST/api/version"
curl --noproxy '*' --connect-timeout 5 --max-time 10 --fail "$OLLAMA_HOST/api/tags"
curl --noproxy '*' --connect-timeout 5 --max-time 10 --fail "$OLLAMA_HOST/api/ps"
```

If unreachable, inspect the host service's listen address and firewall manually;
permit the development container's network only. The gateway mapping alone does
not expose a loopback-only listener. Do not put a desktop IP or credentials in
tracked configuration. See the README's host connection instructions.

Discovered models: `gpt-oss:20b`, `gemma3:12b`, `qwen3:14b`, `qwen3:8b`,
`qwen3-embedding:4b`, `qwen3-embedding:0.6b`, `llama3.1:8b`.
Only **gpt-oss:20b** was exercised. It advertised completion, tools and thinking;
the 20.9B MXFP4 model digest is in [results.json](experiments/a1/results.json).
Discovery does not establish the other models' suitability.

## Configuration and disposable project

[opencode.example.json](experiments/a1/opencode.example.json) is the exact working
V1 configuration. Copy it into the scratch project, never into Vela's normal
checkout. `OLLAMA_MODEL` selects the real model behind the `ollama/local` alias;
set it only after discovery. Both the coding and small-model defaults select the
local provider. `enabled_providers` restricts provider selection to Ollama;
sharing, updates and Git snapshots are disabled.

The latest [online configuration schema](https://opencode.ai/config.json) contains
V2 options. This V1 binary rejected V2 `permissions` with “V2 permissions are not
supported by OpenCode V1.” Use the pinned binary's `--help` and `debug config` to
validate the example; do not mechanically migrate it to the latest website shape.
Relevant V1 references: [CLI](https://opencode.ai/v1/docs/cli/),
[server](https://opencode.ai/v1/docs/server/),
[configuration](https://opencode.ai/v1/docs/config/).
Restart OpenCode after changing configuration; existing processes retain it.

Run from the Code Foundry root. `/tmp/code-foundry-a1` was fresh for this run;
choose a fresh scratch location if retaining an earlier experiment.

```sh
export OLLAMA_MODEL=gpt-oss:20b # Confirm this exact name in /api/tags first.
mkdir -p /tmp/code-foundry-a1/scratch /tmp/code-foundry-a1/evidence
cp docs/experiments/a1/opencode.example.json /tmp/code-foundry-a1/scratch/opencode.json
cat > /tmp/code-foundry-a1/env.sh <<'SH'
#!/bin/sh
exec env -i HOME="$HOME" PATH="$PATH" \
  OLLAMA_HOST="$OLLAMA_HOST" OLLAMA_MODEL="${OLLAMA_MODEL:?Select a discovered model}" \
  XDG_CONFIG_HOME=/tmp/code-foundry-a1/config \
  XDG_DATA_HOME=/tmp/code-foundry-a1/data \
  XDG_CACHE_HOME=/tmp/code-foundry-a1/cache \
  XDG_STATE_HOME=/tmp/code-foundry-a1/state \
  GH_CONFIG_DIR=/tmp/code-foundry-a1/gh \
  /tmp/code-foundry-a1-tools/node_modules/.bin/opencode --pure "$@"
SH
chmod +x /tmp/code-foundry-a1/env.sh
cat > /tmp/code-foundry-a1/scratch/AGENTS.md <<'TEXT'
# Disposable A1 project
Read this file and REQUIREMENTS.md before making changes. Run `node --test clamp.test.mjs` before editing and after editing. Preserve tests. Change only clamp.mjs. Include the marker A1-SCRATCH-READ in your final summary and report the initial failure and final test counts. Do not use the network, Git, or files outside this scratch project.
TEXT
cat > /tmp/code-foundry-a1/scratch/REQUIREMENTS.md <<'TEXT'
Implement clamp(value, min, max): return min below the range, max above it, and the unchanged value inside the range. Throw RangeError when min exceeds max. Do not mutate arguments. Use named ESM export clamp.
TEXT
cat > /tmp/code-foundry-a1/scratch/clamp.mjs <<'JS'
export function clamp(value, min, max) {
  return value;
}
JS
cat > /tmp/code-foundry-a1/scratch/clamp.test.mjs <<'JS'
import assert from 'node:assert/strict';
import test from 'node:test';
import { clamp } from './clamp.mjs';
test('below range', () => assert.equal(clamp(-2, 0, 10), 0));
test('above range', () => assert.equal(clamp(12, 0, 10), 10));
test('inside range', () => assert.equal(clamp(5, 0, 10), 5));
test('inclusive endpoints', () => {
  assert.equal(clamp(0, 0, 10), 0);
  assert.equal(clamp(10, 0, 10), 10);
});
test('inverted range', () => assert.throws(() => clamp(5, 10, 0), RangeError));
JS
cp /tmp/code-foundry-a1/scratch/clamp.mjs /tmp/code-foundry-a1/evidence/clamp.before.mjs
cp /tmp/code-foundry-a1/scratch/clamp.test.mjs /tmp/code-foundry-a1/evidence/clamp.test.before.mjs
```

The wrapper excludes inherited tokens, SSH agent variables and cloud-provider
keys; XDG directories keep OpenCode data separate. `--pure` disables external
plugins. It preserves the user's HOME: this is **not filesystem, network or
credential isolation**. OpenCode still runs as the development user. The scratch
instructions and permission rules are safeguards for this supervised exercise,
not the enforceable boundary required by issue #2.

Only read/glob/grep/edit and `node --test*` shell commands are allowed by the
example. The shell pattern is not a command sandbox; never reuse it for unattended
execution. Unknown permissions in non-interactive `run` are automatically rejected
unless `--auto` is supplied; do not use that override. No GitHub token or `gh`
permission is provided to the model. Inspect merged configuration before a run;
project and user configuration can affect tools, agents, models and plugins.

## Non-interactive commands and observations

The following prompts and options were used; stdout is JSONL and stderr is separate.
The initial coding run used no external timeout; future reruns should use the
bounded form shown for continuation. The provider request timeout is 120 seconds,
not a whole-session runtime limit.

```sh
(cd /tmp/code-foundry-a1/scratch && /tmp/code-foundry-a1/env.sh debug config)
/tmp/code-foundry-a1/env.sh run --dir /tmp/code-foundry-a1/scratch \
  --model ollama/local --agent build --format json --title 'A1 connectivity' \
  'Without using tools, explain what JavaScript Array.prototype.map does in one sentence.' \
  > /tmp/code-foundry-a1/evidence/basic.jsonl 2> /tmp/code-foundry-a1/evidence/basic.stderr
/tmp/code-foundry-a1/env.sh run --dir /tmp/code-foundry-a1/scratch \
  --model ollama/local --agent build --format json --title 'A1 controlled coding' \
  'Read AGENTS.md and REQUIREMENTS.md, inspect the implementation and tests, run the tests to observe failures, implement the requirement, rerun the tests and summarize the change and results.' \
  > /tmp/code-foundry-a1/evidence/coding.jsonl 2> /tmp/code-foundry-a1/evidence/coding.stderr
```

The basic request succeeded. The coding session read both instruction files,
source and tests; ran tests (2 pass, 3 fail); edited only `clamp.mjs`; reran tests
(5 pass, 0 fail); and returned an implementation summary with `A1-SCRATCH-READ`.
The agent did not include the initial failure count in its first summary; the
structured tool output preserved it. Independent validation confirmed five passes
and byte-identical tests. [scratch.diff](experiments/a1/scratch.diff) retains the
source change. Tests cover bounds, interior values and invalid ranges; this is
one small task, not evidence of broad application-level competence.

The coding JSON events spanned 26.508 seconds, excluding startup before the first
event. There were 22 tool calls, including one unavailable `apply_patch` call;
the model recovered with `edit` but inserted literal patch prefixes and repaired
them over several edits. The final tests passed. One `/api/ps` sample showed a
32,768-token context and 12,911,336,488 bytes for both loaded size and `size_vram`
(about 12.0 GiB). These are Ollama-reported fields, not independently measured
host GPU memory. Host CPU, RAM, GPU utilization, peak memory and power were not
measured. OpenCode reports token counts/cache fields and zero configured monetary
cost; that does not measure hardware cost or prove token-accounting accuracy.

## Sessions and structured output

Read `sessionID` from emitted JSON, not a model's final prose. The observed coding
ID was `ses_e3901f851ffeq5jhvOTCO1vZxd`; replace it when reproducing:

```sh
session_id=$(node -e 'const f=require("fs"); const e=f.readFileSync("/tmp/code-foundry-a1/evidence/coding.jsonl","utf8").trim().split("\n").map(JSON.parse); console.log(e.find(x=>x.sessionID).sessionID)')
timeout --signal=TERM --kill-after=5s 120s /tmp/code-foundry-a1/env.sh run \
  --dir /tmp/code-foundry-a1/scratch --session "$session_id" \
  --model ollama/local --agent build --format json \
  'Continue this session. Do not change files. Rerun node --test clamp.test.mjs, then report the original failing-test count, current passing-test count, changed file and project instruction marker from our previous work.' \
  > /tmp/code-foundry-a1/evidence/continuation.jsonl 2> /tmp/code-foundry-a1/evidence/continuation.stderr
timeout --signal=TERM --kill-after=5s 120s /tmp/code-foundry-a1/env.sh run \
  --dir /tmp/code-foundry-a1/scratch --session "$session_id" \
  --model ollama/local --agent build --format json \
  'The prior continuation did not emit a test tool event. Invoke the bash tool now with command node --test clamp.test.mjs. Do not just recall the old results. Do not edit files. Report the fresh test result after the tool completes.' \
  > /tmp/code-foundry-a1/evidence/continuation-verified.jsonl 2> /tmp/code-foundry-a1/evidence/continuation-verified.stderr
/tmp/code-foundry-a1/env.sh session list --format json
/tmp/code-foundry-a1/env.sh export "$session_id" > /tmp/code-foundry-a1/evidence/session.json
node --test /tmp/code-foundry-a1/scratch/clamp.test.mjs
cmp /tmp/code-foundry-a1/scratch/clamp.test.mjs /tmp/code-foundry-a1/evidence/clamp.test.before.mjs
```

The first continuation recalled the correct counts, file and marker but skipped
the requested test invocation. Do not count recalled results as fresh validation.
An explicit corrective continuation emitted a fresh `bash` test event with exit 0
and five passing tests.
`--continue` resumes the latest session and `--fork` can fork a selected session;
these flags were discovered through help but not separately exercised. Prefer an
explicit recorded ID. The same XDG data directory must survive for continuation;
this experiment's `/tmp` state is temporary. Never treat a retained OpenCode
session as Code Foundry's future durable execution-state store.

Observed JSONL types include `step_start`, `tool_use`, `text`, `step_finish` and
`error`. Tool events contain input, output, status, timing and shell exit codes;
step completion includes reason, usage and cost. Session exports retrieve messages
and tool history. Keep raw events private: tool output and API error response
headers/bodies can contain sensitive material. The checked-in results contain
only this synthetic task and credential-free local failure evidence.

## Failure and GitHub handling

```sh
OLLAMA_MODEL=code-foundry-a1-unavailable-model \
  timeout --signal=TERM --kill-after=5s 30s /tmp/code-foundry-a1/env.sh run \
  --dir /tmp/code-foundry-a1/scratch --model ollama/local --agent build --format json \
  'Reply with OK without tools.'
mkdir -p /tmp/code-foundry-a1/no-gh
env -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN \
  GH_CONFIG_DIR=/tmp/code-foundry-a1/no-gh \
  gh issue view 1 --repo aarondewindt/code-foundry --json number,title,url
```

The unavailable model returned JSON `APIError`, HTTP 404, `isRetryable: false`,
and process exit 1; no fallback model was selected. The credential-free `gh`
probe returned exit 4 with login guidance and no token. Separately, the supervisor
successfully read Code Foundry issue #1 with `gh issue view` and Vela repository
metadata/docs with `gh api`. This does not establish read access to an approved
Vela trial issue: none was supplied. Do not infer write authority from available
authentication or silently log in/fall back to a different identity.

## Server/API experiment and integration recommendation

Start the same binary/profile in a second terminal; this experiment bound only
container loopback and was stopped afterward. The temporary server had no password
and no published port. Any future server exposed to another client needs native
server authentication and the issue #2 execution boundary.

```sh
cd /tmp/code-foundry-a1/scratch
/tmp/code-foundry-a1/env.sh serve --hostname 127.0.0.1 --port 4097
```

From the Code Foundry root in another terminal:

```sh
curl --noproxy '*' --fail --max-time 10 http://127.0.0.1:4097/global/health
curl --noproxy '*' --fail --max-time 10 http://127.0.0.1:4097/doc \
  -o /tmp/code-foundry-a1/evidence/openapi.json
python3 docs/experiments/a1/api-probe.py
```

The [probe](experiments/a1/api-probe.py) is a disposable diagnostic, not an
integration client or runner. It primes provider discovery, creates a session,
opens the SSE stream, deliberately times out a synchronous HTTP request after
50 ms, checks status, aborts and resumes the session. It writes local evidence
under `/tmp/code-foundry-a1/evidence`. Tested outcomes:

- Health returned version 1.19.5; `/doc` supplied the running OpenAPI definition.
- `/config/providers` listed only `ollama`; `/config` and `/agent` returned
  configuration and agent definitions. Prefer the running spec over latest docs.
- `POST /session` yielded an ID; `POST /session/{id}/message` accepted text,
  `agent: "build"` and `model: {providerID: "ollama", modelID: "local"}` and
  returned structured message parts with `A1-API-OK` in a normal request.
- The client timeout left the warmed session **busy**. Disconnecting a client does
  not cancel server execution. `POST /session/{id}/abort` returned `true`, status
  became idle, and another message in that session returned `A1-API-RESUMED`.
- SSE `/event` emitted session status/error/idle, message/part updates and deltas.
  `GET /session/{id}/message` retrieved history. Error events also represent
  deliberate cancellation and must be interpreted in context.
- A separate cold-start test sent `POST /session/{id}/prompt_async` (204), waited
  200 ms, confirmed busy, then aborted (200/true). The session became idle, but
  subsequent `/provider` and `/config/providers` requests returned 503 and a new
  prompt returned 500 (`All fibers interrupted without error` in the log).
  Restarting the temporary server restored operation. Priming provider discovery
  before the warmed cancellation test avoided the observed problem. This is one
  observed failure, not a proven root cause or universal workaround.

To reproduce the cold sequence, use a newly started server and **do not** run
provider discovery or the warmed probe first:

```sh
python3 - <<'PY'
import json, time, urllib.request
root = 'http://127.0.0.1:4097'
def post(path, body):
    request = urllib.request.Request(root + path, data=json.dumps(body).encode(),
                                    headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=20) as response:
        data = response.read()
        return json.loads(data) if data else response.status
session = post('/session', {'title': 'A1 API interruption'})['id']
print(post('/session/' + session + '/prompt_async', {
    'model': {'providerID': 'ollama', 'modelID': 'local'}, 'agent': 'build',
    'parts': [{'type': 'text', 'text': 'Without tools, explain JavaScript testing in detail.'}]}))
time.sleep(0.2)
print(post('/session/' + session + '/abort', {}))
PY
curl --noproxy '*' --max-time 10 -w '\nHTTP %{http_code}\n' \
  http://127.0.0.1:4097/config/providers
```

**Recommend CLI `run --format json` with explicit `--dir`, `--model`, `--agent`
and `--session` for the first supervised integration.** It demonstrated coding,
continuation, error output and independent session retrieval without managing a
long-lived server. Consume both process outcome and events; shell test failures
inside a completed model turn need independent validation. Preserve stdout/stderr
separately and require a final completion or classified failure, not merely exit 0.

The server/API offers meaningful advantages for a later worker: asynchronous
prompts, SSE status/deltas, explicit cancellation, inspection and retrieval while
work is active. Before adopting it, investigate the cold-cancellation failure,
verify process/tool termination and reconnection behavior, pin its OpenAPI/SDK
version and establish issue #2's boundary. An HTTP timeout is only a client limit;
use abort, verify idle and bound any termination fallback. The shell `timeout`
wrapper above was available but a forced process-tree kill/recovery was not tested.
No runner, persistence schema or provider abstraction was added.

## Representative worktree acceptance

The updated A1 scope is independent of Vela. A second supervised trial used a
fresh synthetic source repository and a bare clone with `--no-hardlinks`, then
created branch `a1-trial` in its own worktree. Only the disposable fixture received
a seed commit; no Code Foundry or Vela refs were changed. The source checkout
remained clean, and only `clamp.mjs` changed in the task worktree.

The fixture added `.agents/skills/clamp-contract/SKILL.md` with this content:

```md
---
name: clamp-contract
description: Review the fixture clamp contract before implementing clamp.
---

Read REQUIREMENTS.md and preserve clamp.test.mjs. Include A1-SKILL-READ in the summary.
```

The trial copied the example config and added `skills.paths: [".agents/skills"]`
and `permission.skill: {"*": "deny", "clamp-contract": "allow"}`. `debug skill`
discovered the skill, and a completed `skill` tool event proved actual invocation.
The prompt required instruction/skill reads, tests before and after editing,
changing only the implementation, and both markers in the final summary. It ran
with `timeout --signal=TERM --kill-after=5s 180s`, the existing environment wrapper,
`run --dir <worktree> --model ollama/local --agent build --format json`, and no
Git/network permissions. A bounded continuation in the recorded session emitted
a fresh successful test tool event.

[worktree-results.json](experiments/a1/worktree-results.json) retains the base,
profile inputs/tool events, test output, session continuation and independent
review. [worktree-trial.diff](experiments/a1/worktree-trial.diff) retains the change.
Initial tests had three failures; all five passed after implementation, with the
test file byte-identical. The model again attempted unavailable `apply_patch` and
inserted patch prefixes before repairing them. This is a reproducible capability
limitation, not hidden by the eventual green result.

Codex independently reviewed OpenCode's candidate and ran 7,161 finite numeric
range combinations plus 11 invalid-range cases outside the coding session. The
review accepted the named ESM export, range validation order, bounded pure
implementation, unchanged tests and absence of external calls. This establishes
suitability for another narrow pure-code/unit-test task, not broad application
competence or unattended readiness. Supervisor `gh issue view 1` succeeded;
credential-free failures remain recorded in the initial results. No model received
GitHub credentials.

A1's representative criteria are now evidenced. Vela installation, its own
instructions/skills, host paths, real services and a supervised Vela trial belong
to [#9](https://github.com/aarondewindt/code-foundry/issues/9). A2 remains NO-GO
until a restricted profile with service access is actually verified. Queue/state
work in #3 can proceed without that access; no unattended coding is enabled.
