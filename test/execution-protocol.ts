/** Pinned CLI protocol fixture only: fixed text responses, every tool denied. */
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExecutionGateway } from '../src/execution/gateway.js';
const observations: unknown[] = [];
for (const explicitTitle of [false, true]) {
  const root = mkdtempSync(join(tmpdir(), 'cf-b3-negative-protocol-'));
  let upstreamCalls = 0;
  const upstream = createServer(async (_req, res) => {
    upstreamCalls++;
    await new Promise((resolve) => setTimeout(resolve, 750));
    const chunks = [
      {
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'OK' },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ];
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(
      chunks
        .map(
          (c) =>
            'data: ' +
            JSON.stringify({
              id: 'fixture',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'gpt-oss:20b',
              ...c,
            }) +
            '\n\n',
        )
        .join('') + 'data: [DONE]\n\n',
    );
  });
  await new Promise<void>((resolve) =>
    upstream.listen(join(root, 'upstream.sock'), resolve),
  );
  const gateway = new ExecutionGateway(
    join(root, 'upstream.sock'),
    16,
    Date.now() + 30000,
  );
  await new Promise<void>((resolve) =>
    gateway.server.listen(0, '127.0.0.1', resolve),
  );
  const port = (gateway.server.address() as { port: number }).port;
  const config = {
    model: 'ollama/local',
    small_model: 'ollama/local',
    share: 'disabled',
    autoupdate: false,
    snapshot: false,
    enabled_providers: ['ollama'],
    provider: {
      ollama: {
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL: `http://127.0.0.1:${port}/v1`, timeout: 120000 },
        models: {
          local: {
            id: 'gpt-oss:20b',
            name: 'Approved local model',
            tool_call: true,
            limit: { context: 32768, output: 4096 },
          },
        },
      },
    },
    permission: { '*': 'deny' },
    instructions: [],
    skills: { paths: [] },
  };
  const env = {
    PATH: process.env.PATH!,
    HOME: root,
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_STATE_HOME: join(root, 'state'),
    GH_CONFIG_DIR: join(root, 'empty-gh'),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_MODELS_FETCH: 'true',
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
  };
  try {
    assert.equal(
      execFileSync('opencode', ['--version'], {
        env,
        cwd: root,
        encoding: 'utf8',
        timeout: 20000,
      }).trim(),
      '1.19.5',
    );
    const run = async (session?: string) => {
      const args = [
        '--pure',
        'run',
        '--dir',
        root,
        '--model',
        'ollama/local',
        '--agent',
        'build',
        '--format',
        'json',
        ...(explicitTitle
          ? ['--title', 'Deterministic no-tools protocol fixture']
          : []),
        ...(session ? ['--session', session] : []),
        'Reply OK without tools. The provider is a deterministic local protocol fixture returning only fixed text.',
      ];
      const child = spawn('opencode', args, {
        cwd: root,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stop = () => {
        if (child.pid)
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
      };
      let stdout = '';
      let stderrBytes = 0;
      const timer = setTimeout(stop, 20000);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.length > 65536) stop();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > 65536) stop();
      });
      try {
        const exit = await new Promise<{
          code: number | null;
          signal: string | null;
        }>((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code, signal) => resolve({ code, signal }));
        });
        const events = stdout
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(
            (line) => JSON.parse(line) as { type: string; sessionID?: string },
          );
        assert.ok(events.every((event) => event.type !== 'tool_use'));
        return { exit, events };
      } finally {
        clearTimeout(timer);
        stop();
      }
    };
    const initial = await run();
    if (!explicitTitle) {
      assert.equal(initial.exit.code, 1);
      assert.equal(gateway.denial?.reason, 'concurrent-request');
      assert.equal(gateway.requests, 1);
      assert.equal(gateway.tools, 0);
    } else {
      assert.equal(initial.exit.code, 0);
      assert.equal(gateway.denied, false);
      const session = initial.events.find(
        (event) => event.sessionID,
      )?.sessionID;
      assert.ok(session);
      const continued = await run(session);
      assert.equal(continued.exit.code, 0);
      assert.equal(gateway.denied, false);
      assert.ok(
        continued.events.every(
          (event) => !event.sessionID || event.sessionID === session,
        ),
      );
      assert.equal(gateway.requests, 2);
      assert.equal(gateway.tools, 0);
    }
    observations.push({
      explicitTitle,
      initialExit: initial.exit.code,
      nativeContinuationVerified: explicitTitle,
      upstreamCalls,
      requests: gateway.requests,
      toolsGranted: gateway.tools,
      denial: gateway.denial,
    });
  } finally {
    await gateway.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}
console.log(
  JSON.stringify(
    {
      scope:
        'Pinned OpenCode 1.19.5 with fixed text responses and every tool denied; no coding, real inference or host Docker',
      observations,
    },
    null,
    2,
  ),
);
