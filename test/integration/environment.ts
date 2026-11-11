/** Runs only inside the disposable VM. No OpenCode or host model invocation. */
import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { runEnvironmentFixture } from '../environment-fixture.js';
import { reviewedImages } from '../../src/environment/runtime.js';

assert.equal(process.getuid?.(), 1000);
assert.equal(
  readFileSync('/etc/code-foundry-disposable', 'utf8').trim(),
  'code-foundry-disposable-v1',
);
assert.equal(process.cwd(), '/home/cf/code-foundry');
for (const image of Object.values(reviewedImages)) {
  const result = spawnSync(
    'docker',
    ['image', 'inspect', '--format', '{{.Id}}', image],
    {
      encoding: 'utf8',
      timeout: 5000,
    },
  );
  assert.equal(
    result.status,
    0,
    'Approved image missing from disposable guest',
  );
  assert.equal(result.stdout.trim(), image, 'Approved image identity mismatch');
}
const search = spawnSync(
  process.execPath,
  ['--import', 'tsx', 'test/worker-image-host.ts', '--check'],
  {
    timeout: 120_000,
    stdio: 'ignore',
  },
);
assert.equal(
  search.status,
  0,
  'Approved worker image failed restricted search diagnostics',
);

// The production gateway's fixed destination is supervisor loopback. Use a
// powerless upstream there; never change production routing or contact Ollama.
// A separate process keeps serving while the synchronous manager invokes Docker.
const upstream = spawn(
  'python3',
  [
    '-u',
    '-c',
    `
import http.server,json,pathlib
effects=pathlib.Path('/home/cf/model-effects.json')
effects.write_text('[]')
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_GET(self):
  if self.path!='/v1/models': return self.do_POST()
  body=json.dumps({'data':[{'id':'gpt-oss:20b'}]}).encode()
  self.send_response(200)
  self.send_header('Content-Type','application/json')
  self.send_header('Content-Length',str(len(body)))
  self.end_headers()
  self.wfile.write(body)
 def do_POST(self):
  effects.write_text(json.dumps(json.loads(effects.read_text())+[self.path]))
  self.send_response(403)
  self.end_headers()
server=http.server.HTTPServer(('127.0.0.1',11434),Handler)
print('ready',flush=True)
server.serve_forever()
`,
  ],
  { stdio: ['ignore', 'pipe', 'ignore'] },
);
try {
  await Promise.race([
    once(upstream.stdout!, 'data', { signal: AbortSignal.timeout(5000) }),
    once(upstream, 'exit').then(() => {
      throw new Error('Synthetic upstream exited');
    }),
  ]);
  const report = await runEnvironmentFixture({
    retainGateways: false,
    verifyFailures: true,
    reportPath: '/home/cf/environment-report.json',
  });
  assert.equal(
    report.complete,
    true,
    report.error ?? 'Environment integration failed',
  );
  assert.deepEqual(
    JSON.parse(readFileSync('/home/cf/model-effects.json', 'utf8')),
    [],
    'Forbidden request reached protected synthetic upstream',
  );
  writeFileSync(
    '/home/cf/environment-report.json',
    JSON.stringify(
      {
        ...report,
        syntheticModelUpstream: true,
        forbiddenUpstreamRequests: 0,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
} finally {
  if (upstream.exitCode === null && upstream.signalCode === null) {
    const exited = once(upstream, 'exit', {
      signal: AbortSignal.timeout(3000),
    });
    upstream.kill('SIGTERM');
    await exited;
  }
}
