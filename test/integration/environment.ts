/** Disposable VM only: real OpenCode with scripted responses, no host model. */
import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { runEnvironmentFixture } from '../environment-fixture.js';
import { reviewedImages } from '../../src/environment/runtime.js';
import {
  ExecutionController,
  type ExecutionRecord,
} from '../../src/execution/controller.js';

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
  if self.path == '/v1/chat/completions':
   value=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
   messages=value['messages']
   last_user=max(i for i,m in enumerate(messages) if m['role']=='user' and ('Implement only the approved ticket' in json.dumps(m) or 'Repair only the recoverable' in json.dumps(m)))
   repair='Repair only the recoverable' in json.dumps(messages[last_user])
   completed=any(m['role']=='tool' for m in messages[last_user+1:])
   implementation='export const clamp = (value,min,max) => Math.min(max,Math.max(min,value));' if repair else 'export const clamp = (value) => value;'
   command='python3 -c '+__import__('shlex').quote('from pathlib import Path; Path("clamp.mjs").write_text('+repr(implementation)+')')
   # Exercise an actual denied operation within the same real shell tool.
   command += ' && python3 -c '+__import__('shlex').quote('from pathlib import Path\\ntry: Path("/shared/attachment.txt").write_text("forbidden")\\nexcept PermissionError: print("boundary-denied")\\nexcept OSError: print("boundary-denied")\\nelse: raise RuntimeError("boundary failed")')
   message={'role':'assistant','content':'CF_RESULT: candidate'} if completed else {'role':'assistant','content':None,'tool_calls':[{'id':'call_fixture_repair' if repair else 'call_fixture_initial','type':'function','function':{'name':'bash','arguments':json.dumps({'command':command,'description':'Implement synthetic fixture and verify boundary'})}}]}
   reason='stop' if completed else 'tool_calls'
   if value.get('stream'):
    delta=dict(message)
    if 'tool_calls' in delta:
     delta['tool_calls']=[dict(call,index=index) for index,call in enumerate(delta['tool_calls'])]
    chunks=[{'id':'fixture','object':'chat.completion.chunk','created':1,'model':'gpt-oss:20b','choices':[{'index':0,'delta':delta,'finish_reason':None}]},{'id':'fixture','object':'chat.completion.chunk','created':1,'model':'gpt-oss:20b','choices':[{'index':0,'delta':{},'finish_reason':reason}],'usage':{'prompt_tokens':100,'completion_tokens':20,'total_tokens':120}}]
    body=(''.join('data: '+json.dumps(chunk)+'\\n\\n' for chunk in chunks)+'data: [DONE]\\n\\n').encode()
    content_type='text/event-stream'
   else:
    body=json.dumps({'id':'fixture','object':'chat.completion','created':1,'model':'gpt-oss:20b','choices':[{'index':0,'message':message,'finish_reason':reason}],'usage':{'prompt_tokens':100,'completion_tokens':20,'total_tokens':120}}).encode()
    content_type='application/json'
   self.send_response(200)
   self.send_header('Content-Type',content_type)
   self.send_header('Content-Length',str(len(body)))
   self.end_headers()
   self.wfile.write(body)
   return
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
    executionFixture: true,
    onReady: async (store, manager, environment, issue) => {
      try {
        const importMarker = `${environment.worktree}/untrusted-control-import`;
        writeFileSync(
          `${environment.worktree}/socket.py`,
          `from pathlib import Path\nPath(${JSON.stringify(importMarker)}).write_text('untrusted')\nraise RuntimeError('Task-controlled module ran during trusted startup')\n`,
          { flag: 'wx', mode: 0o600 },
        );
        manager.check(environment);
        assert.equal(existsSync(importMarker), false);
        const result = (await new ExecutionController(store, manager).execute(
          environment.taskId,
          issue,
        )) as { execution: ExecutionRecord };
        assert.equal(store.get(environment.taskId).status, 'candidate-ready');
        assert.equal(result.execution.rounds.length, 2);
        assert.equal(result.execution.rounds[0]!.validation[0]!.result.exit, 1);
        assert.equal(result.execution.rounds[1]!.validation[0]!.result.exit, 0);
        assert.ok(result.execution.session);
        const executedTools = result.execution.rounds.reduce(
          (sum, round) => sum + round.tools,
          0,
        );
        assert.equal(executedTools, 2);
        assert.ok(result.execution.toolsGranted >= executedTools);
        assert.ok(
          result.execution.toolsGranted <=
            store.get(environment.taskId).profile.maxToolCalls,
        );
        assert.ok(result.execution.requests >= 4);
        assert.equal(existsSync(importMarker), false);
        assert.equal(
          readFileSync(`${environment.worktree}/clamp.test.mjs`, 'utf8'),
          readFileSync(`${environment.config.source}/clamp.test.mjs`, 'utf8'),
        );
        assert.ok(
          readFileSync(
            `${result.execution.artifacts}/coding-0.stdout`,
            'utf8',
          ).includes('boundary-denied'),
        );
        writeFileSync(
          '/home/cf/execution-report.json',
          JSON.stringify(
            {
              ...result.execution,
              testFilePreserved: true,
              taskControlledStartupModuleIgnored: true,
              implementation: readFileSync(
                `${environment.worktree}/clamp.mjs`,
                'utf8',
              ),
              baselinePatch: readFileSync(
                `${result.execution.artifacts}/baseline-diff.stdout`,
                'utf8',
              ),
              candidatePatch: readFileSync(
                `${result.execution.artifacts}/candidate-diff.stdout`,
                'utf8',
              ),
              scope:
                'Real pinned OpenCode binary with scripted synthetic model responses, not real Ollama inference',
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
      } catch {
        const attempts = store.attempts(environment.taskId) as { id: string }[];
        const execution = store.execution(
          attempts.at(-1)!.id,
        ) as ExecutionRecord | null;
        const logs: Record<string, string> = {};
        if (execution)
          for (const file of [
            'coding-0.stdout',
            'coding-0.stderr',
            'coding-1.stdout',
            'coding-1.stderr',
            'validation-0-0.stdout',
            'validation-0-0.stderr',
          ]) {
            const path = `${execution.artifacts}/${file}`;
            if (existsSync(path))
              logs[file] = readFileSync(path, 'utf8').slice(-12000);
          }
        // Private diagnostic export for this purely synthetic guest fixture.
        // Never copy this field into tracked acceptance evidence without review.
        throw new Error(
          JSON.stringify({
            execution,
            logs,
            failure: 'Synthetic OpenCode controller integration failed',
          }),
        );
      }
    },
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
