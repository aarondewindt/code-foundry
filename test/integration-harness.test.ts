import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('checks VM isolation, cleanup, snapshot filtering and bootstrap network restrictions without Docker', () => {
  const result = spawnSync(
    'python3',
    [
      '-m',
      'unittest',
      'discover',
      '-s',
      'tools/integration',
      '-p',
      'test_*.py',
    ],
    { encoding: 'utf8', timeout: 20_000 },
  );
  expect(result.status, result.stderr).toBe(0);
}, 25_000);
