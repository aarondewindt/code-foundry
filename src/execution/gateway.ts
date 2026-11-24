import { createServer, request, type Server } from 'node:http';

const maximum = 8 * 1024 * 1024;
export type DenialReason =
  | 'concurrent-request'
  | 'deadline'
  | 'request-route'
  | 'request-budget'
  | 'request-size'
  | 'upstream-status'
  | 'upstream-transport'
  | 'response-size'
  | 'response-protocol'
  | 'tool-budget';
export interface ModelDenial {
  reason: DenialReason;
  upstreamStatus?: number;
}
class GatewayFailure extends Error {
  constructor(
    readonly reason: DenialReason,
    readonly upstreamStatus?: number,
  ) {
    super(reason);
  }
}
// Count calls before releasing a complete response. No partial streamed tool
// arguments reach OpenCode when a parallel batch exceeds the remaining budget.
export function toolCalls(raw: string, contentType: string): number {
  if (contentType.split(';')[0] === 'application/json') {
    const value = JSON.parse(raw) as {
      choices: {
        message: { tool_calls?: unknown[]; function_call?: unknown };
        finish_reason: string;
      }[];
    };
    if (value.choices.length !== 1) throw new Error('Unexpected choices');
    const choice = value.choices[0]!;
    if (
      !['stop', 'tool_calls'].includes(choice.finish_reason) ||
      choice.message.function_call
    )
      throw new Error('Incomplete model response');
    if (
      choice.message.tool_calls !== undefined &&
      !Array.isArray(choice.message.tool_calls)
    )
      throw new Error('Malformed tool batch');
    return choice.message.tool_calls?.length ?? 0;
  }
  if (contentType.split(';')[0] !== 'text/event-stream')
    throw new Error('Unexpected response framing');
  const calls = new Set<number>();
  const identities = new Map<number, string>();
  let complete = false;
  let done = false;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') {
      done = true;
      continue;
    }
    if (done) throw new Error('Data after completion');
    const value = JSON.parse(data) as {
      choices: {
        index: number;
        delta: {
          tool_calls?: { index: number; id?: string }[];
          function_call?: unknown;
        };
        finish_reason?: string | null;
      }[];
    };
    if (!Array.isArray(value.choices) || value.choices.length > 1)
      throw new Error('Malformed choices');
    if (complete && value.choices.length)
      throw new Error('Choices after completion');
    for (const choice of value.choices) {
      if (choice.index !== 0 || choice.delta.function_call)
        throw new Error('Unexpected choice');
      if (
        choice.delta.tool_calls !== undefined &&
        !Array.isArray(choice.delta.tool_calls)
      )
        throw new Error('Malformed tool delta');
      for (const call of choice.delta.tool_calls ?? []) {
        if (
          !Number.isSafeInteger(call.index) ||
          call.index < 0 ||
          call.index > 999
        )
          throw new Error('Invalid tool index');
        calls.add(call.index);
        if (call.id !== undefined) {
          if (
            typeof call.id !== 'string' ||
            !call.id ||
            call.id.length > 200 ||
            (identities.has(call.index) &&
              identities.get(call.index) !== call.id) ||
            [...identities].some(
              ([index, id]) => index !== call.index && id === call.id,
            )
          )
            throw new Error('Tool identity changed');
          identities.set(call.index, call.id);
        }
      }
      if (choice.finish_reason) {
        if (!['stop', 'tool_calls'].includes(choice.finish_reason))
          throw new Error('Incomplete generation');
        complete = true;
      }
    }
  }
  if (!complete || !done) throw new Error('Incomplete stream');
  if (calls.size !== identities.size) throw new Error('Missing tool identity');
  return calls.size;
}

export class ExecutionGateway {
  readonly server: Server;
  tools = 0;
  requests = 0;
  denied = false;
  denial: ModelDenial | null = null;
  busy = false;
  constructor(
    readonly upstream: string,
    readonly limit: number,
    readonly deadline: number,
  ) {
    this.server = createServer(async (incoming, outgoing) => {
      const deny = (reason: DenialReason, upstreamStatus?: number) => {
        this.denied = true;
        this.denial ??= {
          reason,
          ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
        };
        outgoing.writeHead(403, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            error: 'Execution policy denied request',
            reason: this.denial.reason,
          }),
        );
      };
      if (this.denied) return deny(this.denial!.reason);
      if (this.busy) return deny('concurrent-request');
      if (Date.now() >= deadline) return deny('deadline');
      if (incoming.method !== 'POST' || incoming.url !== '/v1/chat/completions')
        return deny('request-route');
      if (this.requests >= Math.min(1000, limit * 2 + 8))
        return deny('request-budget');
      this.busy = true;
      this.requests++;
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of incoming) {
          size += (chunk as Buffer).length;
          if (size > 131072) throw new GatewayFailure('request-size');
          chunks.push(chunk as Buffer);
        }
        const body = Buffer.concat(chunks);
        const response = await new Promise<{ body: Buffer; type: string }>(
          (resolve, reject) => {
            const connection = request(
              {
                socketPath: upstream,
                path: '/v1/chat/completions',
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Content-Length': body.length,
                },
                signal: AbortSignal.timeout(
                  Math.max(1, Math.min(130000, deadline - Date.now())),
                ),
              },
              (result) => {
                const output: Buffer[] = [];
                let length = 0;
                result.on('data', (chunk: Buffer) => {
                  length += chunk.length;
                  if (length > maximum)
                    connection.destroy(new GatewayFailure('response-size'));
                  else output.push(chunk);
                });
                result.on('error', reject);
                result.on('end', () =>
                  result.statusCode === 200
                    ? resolve({
                        body: Buffer.concat(output),
                        type: result.headers['content-type'] ?? '',
                      })
                    : reject(
                        new GatewayFailure(
                          'upstream-status',
                          result.statusCode,
                        ),
                      ),
                );
              },
            );
            connection.on('error', reject);
            connection.end(body);
          },
        );
        let count: number;
        try {
          count = toolCalls(response.body.toString('utf8'), response.type);
        } catch {
          throw new GatewayFailure('response-protocol');
        }
        if (this.denied) return deny(this.denial!.reason);
        if (this.tools + count > limit) return deny('tool-budget');
        if (Date.now() >= deadline) return deny('deadline');
        this.tools += count;
        outgoing
          .writeHead(200, {
            'Content-Type': response.type,
            'Content-Length': response.body.length,
          })
          .end(response.body);
      } catch (error) {
        deny(
          error instanceof GatewayFailure ? error.reason : 'upstream-transport',
          error instanceof GatewayFailure ? error.upstreamStatus : undefined,
        );
      } finally {
        this.busy = false;
      }
    });
    this.server.requestTimeout = 10000;
    this.server.headersTimeout = 5000;
    this.server.maxConnections = 4;
  }
  async listen(path: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(path, resolve);
    });
  }
  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
