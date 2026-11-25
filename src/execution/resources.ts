import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { availableParallelism, freemem, loadavg, totalmem } from 'node:os';

export function resourcePressure() {
  let availableRamMiB = Math.floor(freemem() / 1048576);
  try {
    const available = /^MemAvailable:\s+(\d+) kB$/m.exec(
      readFileSync('/proc/meminfo', 'utf8'),
    );
    if (available) availableRamMiB = Math.floor(Number(available[1]) / 1024);
  } catch {
    // Node's free memory is a conservative fallback.
  }
  const gpu = spawnSync(
    'nvidia-smi',
    [
      '--query-gpu=utilization.gpu,memory.used,memory.total',
      '--format=csv,noheader,nounits',
    ],
    { timeout: 1500, encoding: 'utf8', maxBuffer: 8192 },
  );
  const devices =
    gpu.status === 0
      ? gpu.stdout
          .trim()
          .split('\n')
          .map((line) => line.split(',').map((value) => Number(value.trim())))
      : [];
  return {
    cpuLoadPerCore: loadavg()[0]! / availableParallelism(),
    availableRamMiB,
    totalRamMiB: Math.floor(totalmem() / 1048576),
    gpu: devices.flatMap(([utilization, used, total]) =>
      utilization !== undefined &&
      used !== undefined &&
      total !== undefined &&
      Number.isFinite(utilization) &&
      Number.isFinite(used) &&
      total > 0
        ? [{ utilization, usedVramMiB: used, totalVramMiB: total }]
        : [],
    ),
  };
}
