import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { reviewedImages } from '../src/environment/runtime.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
it.each(['success', 'search-failure', 'identity-mismatch', 'check-missing'])(
  'checks search capabilities without selecting a candidate (%s)',
  (scenario) => {
    const failed = scenario !== 'success';
    const root = mkdtempSync(join(tmpdir(), 'cf-image-helper-test-'));
    roots.push(root);
    const bin = join(root, 'bin');
    const temp = join(root, 'tmp');
    mkdirSync(bin);
    mkdirSync(temp);
    const calls = join(root, 'calls.jsonl');
    const tagged = join(root, 'tagged');
    const counter = join(root, 'count');
    const base = reviewedImages.worker;
    // Docker is deliberately stubbed: this tests helper ordering and fail-closed
    // selection, not whether a real image or runtime is secure.
    writeFileSync(
      join(bin, 'docker'),
      `#!/usr/bin/env node
const fs=require('node:fs'); const a=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n');
const out=x=>process.stdout.write(String(x)+'\\n');
if(a[0]==='info') out('linux');
else if(a[0]==='image'&&a[1]==='tag') fs.writeFileSync(${JSON.stringify(tagged)},'yes');
else if(a[0]==='image'&&a[1]==='inspect') {
 if(!a.includes('--format')&&!fs.existsSync(${JSON.stringify(tagged)})) process.exit(1);
 out(a.at(-1)==='sha256:'+'c'.repeat(64)?'sha256:'+'d'.repeat(64):${JSON.stringify(base)});
}
else if(a[0]==='create') {
 let n=fs.existsSync(${JSON.stringify(counter)})?Number(fs.readFileSync(${JSON.stringify(counter)},'utf8')):0;
 fs.writeFileSync(${JSON.stringify(counter)},String(n+1)); out((n?'b':'a').repeat(64));
}
else if(a[0]==='start') out(JSON.stringify(a.at(-1)==='a'.repeat(64)?{path:null,available:false}:{path:'/usr/bin/rg',available:${JSON.stringify(scenario !== 'search-failure')}}));
else if(a[0]==='inspect') {
 if(a.includes('{{.Image}}')) out(a.at(-1)==='b'.repeat(64)?'sha256:'+(${JSON.stringify(scenario === 'identity-mismatch')}?'e':'d').repeat(64):${JSON.stringify(base)});
 else if(a.includes('{{.AppArmorProfile}}')) out('docker-default');
 else out(a.includes('{{.State.Running}}')?'false':'0');
}
else if(a[0]==='stop') out(a.at(-1));
else if(a[0]==='build') fs.writeFileSync(a[a.indexOf('--iidfile')+1],'sha256:'+'c'.repeat(64));
else process.exit(3);
`,
      { mode: 0o700 },
    );
    const pins = readFileSync('src/environment/runtime.ts', 'utf8');
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'test/worker-image-host.ts',
        scenario === 'check-missing' ? '--check' : '--build-candidate',
      ],
      {
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          TMPDIR: temp,
        },
      },
    );
    expect(result.status, result.stderr).toBe(failed ? 1 : 0);
    const rootLine = result.stdout
      .split('\n')
      .find((line) => line.startsWith('Retained image verification root: '));
    expect(rootLine).toBeDefined();
    const reportRoot = rootLine!.slice(
      'Retained image verification root: '.length,
    );
    expect(reportRoot.startsWith(temp + '/')).toBe(true);
    const report = JSON.parse(
      readFileSync(join(reportRoot, 'report.json'), 'utf8'),
    ) as {
      complete: boolean;
      pinsChanged: boolean;
      candidateImage: string;
      candidateImageId: string;
      candidateContainerImageId: string;
      error?: string;
    };
    expect(report.complete).toBe(!failed);
    expect(report.pinsChanged).toBe(false);
    if (scenario === 'check-missing') {
      const commands = readFileSync(calls, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]);
      expect(
        commands.some((args) => args[0] === 'build' || args[1] === 'tag'),
      ).toBe(false);
      expect(report.error).toContain('check mode never builds');
      expect(readFileSync('src/environment/runtime.ts', 'utf8')).toBe(pins);
      return;
    }
    expect(report.candidateImage).toBe('sha256:' + 'c'.repeat(64));
    expect(readFileSync('src/environment/runtime.ts', 'utf8')).toBe(pins);
    expect(report.candidateImageId).toBe('sha256:' + 'd'.repeat(64));
    if (scenario === 'search-failure')
      expect(report.error).toContain('failed restricted search');
    else if (scenario === 'identity-mismatch')
      expect(report.error).toContain('runtime image or AppArmor mismatch');
    else expect(report.candidateContainerImageId).toBe(report.candidateImageId);
    const commands = readFileSync(calls, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    const creations = commands.filter((a) => a[0] === 'create');
    expect(creations).toHaveLength(2);
    for (const args of creations) {
      expect(args).toContain('apparmor=docker-default');
      expect(args).toContain('no-new-privileges=true');
      expect(
        args.slice(args.indexOf('--network'), args.indexOf('--network') + 2),
      ).toEqual(['--network', 'none']);
      expect(args).not.toContain('--privileged');
      expect(args.find((a) => a.includes('target=/fixture'))).toContain(
        'readonly',
      );
    }
    expect(commands.filter((a) => a[0] === 'stop')).toHaveLength(2);
  },
  20_000,
);
