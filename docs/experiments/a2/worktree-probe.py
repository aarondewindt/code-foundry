"""Synthetic Git repos under the existing host-backed, ignored dependency directory."""

import json
import os
from pathlib import Path
import subprocess
import tempfile

cache = Path.cwd() / 'node_modules/.cache'
if not (Path.cwd() / 'AGENTS.md').is_file() or not cache.parent.is_dir():
    raise SystemExit('Run from Code Foundry after yarn install --immutable.')
cache.mkdir(exist_ok=True)
env = {
    'PATH': os.environ['PATH'],
    'GIT_CONFIG_NOSYSTEM': '1',
    'GIT_CONFIG_GLOBAL': '/dev/null',
    'GIT_TERMINAL_PROMPT': '0',
}

def git(*args, check=True):
    result = subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', *map(str, args)],
                            env=env, capture_output=True, text=True, timeout=20)
    if check and result.returncode:
        raise RuntimeError(result.stderr)
    return result

with tempfile.TemporaryDirectory(prefix='code-foundry-a2-', dir=cache) as tmp:
    root = Path(tmp)
    source = root / 'synthetic-main'
    bundle = root / 'task-bundle'
    bundle.mkdir()
    store = bundle / 'store.git'
    tree = bundle / 'worktree'
    git('init', '--initial-branch=main', source)
    (source / 'fixture.txt').write_text('original synthetic source\n')
    git('-C', source, 'add', 'fixture.txt')
    git('-C', source, '-c', 'user.name=A2 Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Disposable synthetic fixture')
    base = git('-C', source, 'rev-parse', 'HEAD').stdout.strip()
    git('clone', '--bare', '--no-hardlinks', source, store)
    git('--git-dir', store, 'worktree', 'add', '-b', 'a2-synthetic-task', tree, base)
    (tree / 'fixture.txt').write_text('task-only change\n')
    source_unchanged = (source / 'fixture.txt').read_text() == 'original synthetic source\n' and not git('-C', source, 'status', '--porcelain').stdout
    gitfile = (tree / '.git').read_text().replace(str(root), '<fixture>')
    main_git = git('-C', source, 'rev-parse', '--absolute-git-dir').stdout.strip()
    task_common = git('-C', tree, 'rev-parse', '--path-format=absolute', '--git-common-dir').stdout.strip()
    source_objects = list((source / '.git/objects').glob('*/*'))
    separate_objects = all(not (store / 'objects' / p.relative_to(source / '.git/objects')).exists() or
                           p.stat().st_ino != (store / 'objects' / p.relative_to(source / '.git/objects')).stat().st_ino for p in source_objects)
    moved = root / 'relocated-bundle'
    bundle.rename(moved)
    broken = git('-C', moved / 'worktree', 'status', '--porcelain', check=False)
    git('--git-dir', moved / 'store.git', 'worktree', 'repair', moved / 'worktree')
    repaired = git('-C', moved / 'worktree', 'diff', '--', 'fixture.txt')
    report = {
        'scope': 'Synthetic repository only; no Code Foundry or Vela refs/commits changed.',
        'seedCommit': base,
        'taskBranch': 'a2-synthetic-task',
        'sourceUnchanged': bool(source_unchanged),
        'independentCommonMetadata': main_git != task_common,
        'objectsNotHardlinked': separate_objects,
        'gitfileBeforeRelocation': gitfile.strip(),
        'relocatedStatusExit': broken.returncode,
        'repairedDiffShowsTaskChange': '+task-only change' in repaired.stdout,
        'hostBackedLocation': 'node_modules/.cache on the workspace bind mount',
        'ubuntuAndVscodeOpeningTested': False,
        'cleanup': 'Only this temporary synthetic repository is removed on exit.',
    }
print(json.dumps(report, indent=2))
