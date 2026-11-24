/** Explicit host opt-in; never invoked by ordinary tests or the VM harness. */
import { strict as assert } from 'node:assert';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ExecutionController,
  type ExecutionRecord,
} from '../src/execution/controller.js';
import { runEnvironmentFixture } from './environment-fixture.js';

assert.equal(
  process.env.CF_HOST_VERIFY,
  'disposable-synthetic-opencode-only',
  'Host verification requires explicit opt-in and the already verified B2 host boundary',
);
const directory = mkdtempSync(join(tmpdir(), 'cf-b3-host-'));
console.log(`Private host evidence: ${directory}`);
const report = await runEnvironmentFixture({
  retainGateways: true,
  executionFixture: true,
  verifyFailures: true,
  reportPath: join(directory, 'environments.json'),
  onReady: async (store, manager, environment, issue) => {
    const result = (await new ExecutionController(store, manager).execute(
      environment.taskId,
      issue,
    )) as { execution: ExecutionRecord };
    writeFileSync(
      join(directory, 'execution.json'),
      JSON.stringify(
        {
          ...result,
          hostHelperSha256: createHash('sha256')
            .update(readFileSync(new URL(import.meta.url)))
            .digest('hex'),
          fixtureSha256: createHash('sha256')
            .update(
              readFileSync(
                new URL('./environment-fixture.ts', import.meta.url),
              ),
            )
            .digest('hex'),
          scope:
            'Real OpenCode/Ollama on the explicitly opted-in representative host; not Vela acceptance',
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    const outcome = store.get(environment.taskId).status;
    if (outcome !== 'candidate-ready')
      throw new Error(
        `Host execution stopped: ${outcome}; model denial: ${result.execution.modelDenial?.reason ?? 'none'}; reason: ${result.execution.unresolved.join('; ')}. Inspect ${directory}/execution.json`,
      );
    // These bounded files are supervisor-owned captures outside worker mounts;
    // never follow task-created source paths or export database/session secrets.
    for (const name of ['baseline-diff', 'candidate-diff']) {
      copyFileSync(
        join(result.execution.artifacts, `${name}.stdout`),
        join(directory, `${name}.patch`),
      );
    }
  },
});
assert.equal(
  report.complete,
  true,
  report.error ?? 'Host execution verification failed',
);
console.log(
  'Synthetic resources and gateways retained. No GitHub mutation or automatic cleanup occurred.',
);
