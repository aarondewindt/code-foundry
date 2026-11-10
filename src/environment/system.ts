import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { keys, object } from '../queue/config.js';
import type { EnvironmentConfig } from './types.js';

export type Run = (program: string, args: string[], input?: string) => string;
export const run: Run = (program, args, input) => {
  const result = spawnSync(program, args, {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: '/nonexistent',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
    ...(input === undefined ? {} : { input }),
  });
  // Never disclose child stderr: Git filters, SQL and runtime errors can contain credentials.
  if (result.error || result.status !== 0)
    throw new Error(
      `${program} operation failed; inspect supervisor resources locally`,
    );
  return result.stdout.trim();
};
export function git(args: string[], execute: Run = run): string {
  return execute('git', [
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'protocol.file.allow=always',
    ...args,
  ]);
}
export function within(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}
export function canonical(path: unknown): string {
  if (
    typeof path !== 'string' ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    /[\s,:]/.test(path) ||
    realpathSync(path) !== path
  )
    throw new Error(
      'Expected an existing canonical absolute path without whitespace, commas or colons',
    );
  return path;
}
export function readEnvironmentConfig(path: string): EnvironmentConfig {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    throw new Error('Invalid environment configuration JSON');
  }
  const data = object(value);
  keys(data, [
    'source',
    'shared',
    'modelGateway',
    'workerImage',
    'databaseImage',
  ]);
  const result = {
    source: canonical(data.source),
    shared: canonical(data.shared),
    modelGateway: canonical(data.modelGateway),
    workerImage: String(data.workerImage),
    databaseImage: String(data.databaseImage),
  };
  for (const image of [result.workerImage, result.databaseImage])
    if (!/^sha256:[a-f0-9]{64}$/.test(image))
      throw new Error('Images must be immutable reviewed local IDs');
  for (const directory of [result.source, result.shared, result.modelGateway])
    if (!lstatSync(directory).isDirectory())
      throw new Error('Expected a directory');
  return result;
}
