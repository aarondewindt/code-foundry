import { spawn } from 'node:child_process';
import { openSync, closeSync, writeSync } from 'node:fs';

export interface ProcessResult {
  exit: number | null;
  signal: string | null;
  limited: boolean;
  startedAt: string;
  finishedAt: string;
}
export async function capture(
  program: string,
  args: string[],
  prefix: string,
  deadline: number,
  onLine?: (line: string) => void,
): Promise<ProcessResult> {
  const startedAt = new Date().toISOString();
  const files = [
    openSync(`${prefix}.stdout`, 'wx', 0o600),
    openSync(`${prefix}.stderr`, 'wx', 0o600),
  ];
  let limited = false;
  let pending = '';
  const child = spawn(program, args, {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: '/nonexistent',
      LC_ALL: 'C',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => {
    limited = true;
    child.kill('SIGKILL');
  };
  const timer = setTimeout(stop, Math.max(1, deadline - Date.now()));
  const sizes = [0, 0];
  [child.stdout, child.stderr].forEach((stream, index) =>
    stream.on('data', (chunk: Buffer) => {
      sizes[index] = sizes[index]! + chunk.length;
      if (sizes[index]! > 2 * 1024 * 1024) return stop();
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
            stop();
          }
        }
        if (pending.length > 262144) stop();
      }
    }),
  );
  try {
    return await new Promise<ProcessResult>((resolve) => {
      child.once('error', () => {
        limited = true;
      });
      child.once('close', (exit, signal) => {
        if (pending.trim() && onLine) {
          try {
            onLine(pending);
          } catch {
            limited = true;
          }
        }
        resolve({
          exit,
          signal,
          limited,
          startedAt,
          finishedAt: new Date().toISOString(),
        });
      });
    });
  } finally {
    clearTimeout(timer);
    files.forEach(closeSync);
  }
}
