/** Opt-in diagnostics/candidate build; never changes approved image pins. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { reviewedImages } from '../src/environment/runtime.js';

const build = process.argv.slice(2);
if (build.length !== 1 || build[0] !== '--build-candidate')
  throw new Error(
    'Usage: node --import tsx test/worker-image-host.ts --build-candidate (disposable synthetic Docker diagnostics; retained candidate build only if rg is missing)',
  );
const invoke = (args: string[], timeout = 30_000) =>
  spawnSync('docker', args, {
    encoding: 'utf8',
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
const command = (args: string[]) => {
  const result = invoke(args);
  if (result.error || result.status !== 0)
    throw new Error('Docker operation failed; no image pin changed');
  return result.stdout.trim();
};
if (
  command(['info', '--format', '{{.OSType}}']) !== 'linux' ||
  !process.getuid?.()
)
  throw new Error(
    'Use the non-root Ubuntu supervisor with existing Linux Docker access',
  );
const root = mkdtempSync(join(tmpdir(), 'cf-b2-worker-image-'));
console.log(`Retained image verification root: ${root}`);
const fixture = join(root, 'fixture');
mkdirSync(fixture, { mode: 0o755 });
writeFileSync(join(fixture, 'fixture.txt'), 'synthetic search fixture\n', {
  mode: 0o644,
});
const report: Record<string, unknown> = {
  complete: false,
  baseImage: reviewedImages.worker,
  pinsChanged: false,
  scope:
    'Synthetic search capability/candidate image check; not integrated B2 acceptance',
};
const source = readFileSync('runtime/environment/worker.Dockerfile');
report.dockerfileSha256 = createHash('sha256').update(source).digest('hex');
report.helperSha256 = createHash('sha256')
  .update(readFileSync('test/worker-image-host.ts'))
  .digest('hex');
const probe = `import json,os,pathlib,shutil,subprocess
assert os.getuid()!=0
assert pathlib.Path('/proc/self/attr/current').read_text().strip()=='docker-default (enforce)'
status=pathlib.Path('/proc/self/status').read_text()
assert 'NoNewPrivs:\\t1' in status and 'CapEff:\\t0000000000000000' in status and 'Seccomp:\\t2' in status
result={'path':shutil.which('rg'),'available':False}
if result['path']:
 version=subprocess.run(['rg','--version'],capture_output=True,text=True,timeout=5)
 listing=subprocess.run(['rg','--files','/fixture'],capture_output=True,text=True,timeout=5)
 search=subprocess.run(['rg','--fixed-strings','synthetic search fixture','/fixture/fixture.txt'],capture_output=True,text=True,timeout=5)
 result.update(versionExit=version.returncode,filesExit=listing.returncode,searchExit=search.returncode,version=version.stdout.splitlines()[:1],fixtureListed='/fixture/fixture.txt' in listing.stdout.splitlines())
 result['available']=all(code==0 for code in [version.returncode,listing.returncode,search.returncode]) and result['fixtureListed']
print(json.dumps(result))`;
const assertStopped = (id: string) => {
  if (command(['inspect', '--format', '{{.State.Running}}', id]) !== 'false')
    throw new Error('Diagnostic container termination unverified');
};
const checkImage = (image: string, label: string) => {
  // BuildKit's iidfile can name a manifest list. Pin/review the concrete
  // runtime image ID separately and verify the container actually used it.
  const imageId = command(['image', 'inspect', '--format', '{{.Id}}', image]);
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId))
    throw new Error('Invalid runtime image identity');
  report[`${label}ImageId`] = imageId;
  const id = command([
    'create',
    '--pull=never',
    '--label',
    `code-foundry.synthetic-image-check=${basename(root)}`,
    '--init',
    '--network',
    'none',
    '--ipc',
    'private',
    '--cgroupns',
    'private',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges=true',
    '--security-opt',
    'apparmor=docker-default',
    '--cpus',
    '2',
    '--memory',
    '4g',
    '--memory-swap',
    '4g',
    '--pids-limit',
    '128',
    '--ulimit',
    'core=0',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,noexec,size=512m,mode=1777',
    '--user',
    `${process.getuid?.()}:${process.getgid?.()}`,
    '--mount',
    `type=bind,source=${fixture},target=/fixture,readonly,bind-recursive=disabled`,
    '--entrypoint',
    'python3',
    image,
    '-c',
    probe,
  ]);
  if (!/^[a-f0-9]{64}$/.test(id))
    throw new Error('Invalid diagnostic container identity');
  report[`${label}ContainerId`] = id;
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  try {
    const result = invoke(['start', '--attach', id]);
    writeFileSync(join(root, `${label}.stdout`), result.stdout ?? '', {
      mode: 0o600,
    });
    writeFileSync(join(root, `${label}.stderr`), result.stderr ?? '', {
      mode: 0o600,
    });
    if (
      result.error ||
      result.status !== 0 ||
      command(['inspect', '--format', '{{.State.ExitCode}}', id]) !== '0'
    )
      throw new Error(
        'Restricted image probe failed; inspect retained stdout/stderr',
      );
    const runtimeImage = command(['inspect', '--format', '{{.Image}}', id]);
    const apparmor = command([
      'inspect',
      '--format',
      '{{.AppArmorProfile}}',
      id,
    ]);
    report[`${label}ContainerImageId`] = runtimeImage;
    report[`${label}AppArmorProfile`] = apparmor;
    if (runtimeImage !== imageId || apparmor !== 'docker-default')
      throw new Error('Diagnostic runtime image or AppArmor mismatch');
    return JSON.parse(result.stdout) as {
      path: string | null;
      available: boolean;
    };
  } finally {
    command(['stop', '--time', '2', id]);
    assertStopped(id);
  }
};
try {
  if (
    command([
      'image',
      'inspect',
      '--format',
      '{{.Id}}',
      reviewedImages.worker,
    ]) !== reviewedImages.worker
  )
    throw new Error('Reviewed base image identity mismatch');
  const original = checkImage(reviewedImages.worker, 'original');
  report.original = original;
  if (original.path !== null) {
    report.complete = original.available;
    report.nextAction =
      'Standalone rg is present. Review search exit codes and the original worktree failure before changing the image.';
  } else {
    const alias = `code-foundry-b2-worker-base:${basename(root)}`;
    if (invoke(['image', 'inspect', alias]).status === 0)
      throw new Error('Refusing to replace an existing image alias');
    command(['image', 'tag', reviewedImages.worker, alias]);
    report.baseAlias = alias;
    console.log(
      'Standalone rg is missing. Building a candidate with ripgrep inside the image; host packages and security settings are unchanged.',
    );
    const imageFile = join(root, 'candidate-image-id');
    const built = invoke(
      [
        'build',
        '--pull=false',
        '--build-arg',
        `CF_WORKER_BASE=${alias}`,
        '--iidfile',
        imageFile,
        '--file',
        'runtime/environment/worker.Dockerfile',
        'runtime/environment',
      ],
      300_000,
    );
    writeFileSync(
      join(root, 'build.log'),
      (built.stdout ?? '') + (built.stderr ?? ''),
      { mode: 0o600 },
    );
    if (built.error || built.status !== 0)
      throw new Error('Candidate build failed; inspect retained build.log');
    const image = readFileSync(imageFile, 'utf8').trim();
    if (
      !/^sha256:[a-f0-9]{64}$/.test(image) ||
      command(['image', 'inspect', '--format', '{{.Id}}', alias]) !==
        reviewedImages.worker
    )
      throw new Error('Candidate/base image identity mismatch');
    report.candidateImage = image;
    const candidate = checkImage(image, 'candidate');
    report.candidate = candidate;
    if (!candidate.available)
      throw new Error('Candidate failed restricted search capability checks');
    report.complete = true;
    report.nextAction =
      'Copy this report folder to scratch for review. The candidate is not approved or selected; its immutable ID must be reviewed before B2 integration is rerun.';
  }
} catch (error) {
  report.error =
    error instanceof Error ? error.message : 'Image verification failed';
  process.exitCode = 1;
} finally {
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify(report, null, 2));
  console.log(
    'Images, stopped diagnostic containers and evidence are retained. No approved image pin was changed.',
  );
}
