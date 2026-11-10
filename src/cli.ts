#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const metadata: unknown = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

if (
  typeof metadata !== 'object' ||
  metadata === null ||
  !('version' in metadata) ||
  typeof metadata.version !== 'string'
) {
  throw new Error('Missing package version');
}

const args = process.argv.slice(2);
if (args.length === 1 && ['--version', '-v'].includes(args[0] ?? '')) {
  console.log(`Code Foundry ${metadata.version}`);
} else if (
  args.length === 0 ||
  (args.length === 1 && ['--help', '-h'].includes(args[0] ?? ''))
) {
  console.log(`Code Foundry ${metadata.version}

Usage: code-foundry [--help | --version]

Local-first AI development automation.
Task orchestration is not implemented yet.`);
} else {
  console.error('Unknown arguments. Use --help for usage.');
  process.exitCode = 1;
}
