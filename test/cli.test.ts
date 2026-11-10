import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const run = (...args: string[]) =>
  execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd,
    encoding: 'utf8',
  });

describe('CLI', () => {
  it('reports the package version', () => {
    const { version } = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(run('--version')).toBe(`Code Foundry ${version}\n`);
  });

  it('prints usage by default and on request', () => {
    expect(run()).toBe(run('--help'));
    expect(run('--help')).toContain('Usage: code-foundry');
  });

  it('rejects unsupported commands', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'run'],
      { cwd, encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown arguments');
  });
});
