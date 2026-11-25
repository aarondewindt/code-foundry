import { spawnSync } from 'node:child_process';
import { closeSync, constants, openSync } from 'node:fs';

export class ExecutionLockUnavailable extends Error {}

// flock operates on the inherited open file description. The supervisor keeps
// that description open across async work, and the kernel releases it on exit.
export function executionLock(statePath: string): () => void {
  const fd = openSync(
    `${statePath}.execution.lock`,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  const result = spawnSync('flock', ['-n', '3'], {
    stdio: ['ignore', 'ignore', 'ignore', fd],
    timeout: 5000,
  });
  if (result.status !== 0) {
    closeSync(fd);
    throw new ExecutionLockUnavailable('Execution supervisor lock unavailable');
  }
  return () => closeSync(fd);
}
