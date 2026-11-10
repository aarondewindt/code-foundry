import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import type { Environment } from './types.js';
import { git, within, type Run, run } from './system.js';

export function prepareGit(environment: Environment, execute: Run = run): void {
  const { root, worktree, branch, base, config } = environment;
  // No local clone optimization, hard links, alternates, remotes or source hooks.
  const store = join(root, 'store.git');
  git(
    [
      'clone',
      '--bare',
      '--no-local',
      '--no-hardlinks',
      '--',
      config.source,
      store,
    ],
    execute,
  );
  git(['--git-dir', store, 'remote', 'remove', 'origin'], execute);
  git(
    ['--git-dir', store, 'worktree', 'add', '-b', branch, worktree, base],
    execute,
  );
  for (const directory of ['home', 'cache', 'build', 'uploads'])
    mkdirSync(join(root, directory), { mode: 0o700 });
  verifyGit(environment, execute);
}
export function verifyGit(environment: Environment, execute: Run = run): void {
  const { root, worktree, base, branch } = environment;
  const store = join(root, 'store.git');
  if (realpathSync(root) !== root || realpathSync(worktree) !== worktree)
    throw new Error('Task path mismatch');
  const common = git(
    ['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    execute,
  );
  if (common !== store || realpathSync(common) !== store)
    throw new Error('Git metadata escapes task');
  if (
    git(['-C', worktree, 'rev-parse', 'HEAD'], execute) !== base ||
    git(['-C', worktree, 'branch', '--show-current'], execute) !== branch
  )
    throw new Error('Task Git base or branch changed');
  const metadata = resolve(
    worktree,
    readFileSync(join(worktree, '.git'), 'utf8')
      .trim()
      .replace(/^gitdir: /, ''),
  );
  if (
    !within(store, metadata) ||
    realpathSync(metadata) !== metadata ||
    readFileSync(join(metadata, 'gitdir'), 'utf8').trim() !==
      join(worktree, '.git')
  )
    throw new Error('Git worktree back-pointer mismatch');
  function inspect(path: string): void {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      const info = lstatSync(file);
      if (
        info.isSymbolicLink() ||
        (info.isFile() && info.nlink !== 1) ||
        entry.name === 'alternates'
      )
        throw new Error('Shared or linked Git storage refused');
      if (info.isDirectory()) inspect(file);
    }
  }
  inspect(store);
}
