/** Explicit host acceptance; retains fixture services and resources. */
import { spawnSync } from 'node:child_process';
import { runEnvironmentFixture } from './environment-fixture.js';

if (process.env.CF_HOST_VERIFY !== 'disposable-synthetic-only')
  throw new Error(
    'Set CF_HOST_VERIFY=disposable-synthetic-only on the Ubuntu host to run retained disposable integration fixtures',
  );
const engine = spawnSync('docker', ['info', '--format', '{{.OSType}}'], {
  encoding: 'utf8',
  timeout: 5000,
});
if (engine.error || engine.status !== 0 || engine.stdout.trim() !== 'linux')
  throw new Error(
    'Live host verification blocked: an existing Linux Docker engine is required. No infrastructure is installed.',
  );
const report = await runEnvironmentFixture({ retainGateways: true });
console.log(
  'Retained all services, gateways, volumes, worktrees and manifests; no automatic host cleanup.',
);
if (!report.complete) process.exitCode = 1;
