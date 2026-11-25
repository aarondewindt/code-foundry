/** Child supervisor used only by the disposable guest recovery trial. */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { ExecutionController } from '../../src/execution/controller.js';
import { ExecutionRuntime } from '../../src/execution/runtime.js';
import { EnvironmentManager } from '../../src/environment/manager.js';
import type { IssueSnapshot } from '../../src/queue/github.js';
import { QueueStore } from '../../src/queue/store.js';

assert.equal(
  readFileSync('/etc/code-foundry-disposable', 'utf8').trim(),
  'code-foundry-disposable-v1',
);
const [path, id, rawIssue] = process.argv.slice(2);
assert.ok(path && id && rawIssue);
const issue = JSON.parse(rawIssue) as IssueSnapshot;
assert.equal(issue.repository, 'synthetic/fixture');

class InterruptedRuntime extends ExecutionRuntime {
  override run(...args: Parameters<ExecutionRuntime['run']>) {
    if (args[3].mode === 'coding') {
      const onLine = args[7];
      args[7] = (line) => {
        onLine?.(line);
        const event = JSON.parse(line) as { type: string };
        if (event.type === 'tool_use') process.kill(process.pid, 'SIGKILL');
      };
    }
    return super.run(...args);
  }
}

const store = new QueueStore(path);
try {
  const manager = new EnvironmentManager(store, path);
  await new ExecutionController(
    store,
    manager,
    new InterruptedRuntime(manager.runtime),
  ).execute(id, issue);
  throw new Error(
    'Expected deliberate supervisor interruption after a native tool event',
  );
} finally {
  store.close();
}
