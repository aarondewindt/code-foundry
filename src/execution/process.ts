import { spawn } from 'node:child_process';
import { openSync, closeSync, writeSync } from 'node:fs';

export interface ProcessResult {
  exit: number | null;
  signal: string | null;
  limited: boolean;
  limitReason?: 'deadline' | 'output' | 'protocol' | 'control' | 'spawn';
  startedAt: string;
  finishedAt: string;
}
export async function capture(
  program: string,
  args: string[],
  prefix: string,
  deadline: number,
  onLine?: (line: string) => void,
  interrupted?: () => boolean,
): Promise<ProcessResult> {
  const startedAt = new Date().toISOString();
  const files = [
    openSync(`${prefix}.stdout`, 'wx', 0o600),
    openSync(`${prefix}.stderr`, 'wx', 0o600),
  ];
  let limitReason: ProcessResult['limitReason'];
  let pending = '';
  const child = spawn(program, args, {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: '/nonexistent',
      LC_ALL: 'C',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = (reason: NonNullable<ProcessResult['limitReason']>) => {
    limitReason ??= reason;
    child.kill('SIGKILL');
  };
  const timer = setTimeout(
    () => stop('deadline'),
    Math.max(1, deadline - Date.now()),
  );
  const poll =
    interrupted &&
    setInterval(() => {
      if (interrupted()) stop('control');
    }, 200);
  const sizes = [0, 0];
  [child.stdout, child.stderr].forEach((stream, index) =>
    stream.on('data', (chunk: Buffer) => {
      sizes[index] = sizes[index]! + chunk.length;
      if (sizes[index]! > 2 * 1024 * 1024) return stop('output');
      writeSync(files[index]!, chunk);
      if (index === 0 && onLine) {
        pending += chunk.toString('utf8');
        let end;
        while ((end = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          try {
            if (line.trim()) onLine(line);
          } catch {
            stop('protocol');
          }
        }
        if (pending.length > 262144) stop('output');
      }
    }),
  );
  try {
    return await new Promise<ProcessResult>((resolve) => {
      child.once('error', () => {
        limitReason ??= 'spawn';
      });
      child.once('close', (exit, signal) => {
        if (pending.trim() && onLine) {
          try {
            onLine(pending);
          } catch {
            limitReason ??= 'protocol';
          }
        }
        resolve({
          exit,
          signal,
          limited: limitReason !== undefined,
          ...(limitReason ? { limitReason } : {}),
          startedAt,
          finishedAt: new Date().toISOString(),
        });
      });
    });
  } finally {
    clearTimeout(timer);
    clearInterval(poll);
    files.forEach(closeSync);
  }
}
