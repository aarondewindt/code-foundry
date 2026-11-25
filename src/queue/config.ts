import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

export interface Profile {
  agent: string;
  provider: string;
  model: string;
  runtimeSeconds: number;
  maxToolCalls: number;
  maxRepairs: number;
  instructions?: string[];
  skills?: string[];
  admission?: {
    maxCpuLoadPerCore?: number;
    minAvailableRamMiB?: number;
    maxGpuPercent?: number;
    minAvailableVramMiB?: number;
  };
}
export interface Project {
  repository: string;
  taskRoot: string;
  validation: string[][];
  serviceRefs: Record<string, string>;
  defaultProfile: string;
  profiles: Record<string, Profile>;
  allowedOverrides: (keyof Profile)[];
}
export type Overrides = Partial<Profile>;

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a configuration object');
  }
  return value as Record<string, unknown>;
}
export function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error(
      'Unsupported configuration field; use references for secrets',
    );
  }
}
export function name(value: unknown): string {
  if (typeof value !== 'string' || !/^[\w./:@-]{1,200}$/.test(value)) {
    throw new Error('Invalid name or reference');
  }
  if (value.includes('://') || value.includes('@') || value.includes('..')) {
    throw new Error(
      'Names must not contain URLs, credentials or parent traversal',
    );
  }
  return value;
}
export function validateProfile(value: unknown): Profile {
  const p = object(value);
  keys(p, [
    'agent',
    'provider',
    'model',
    'runtimeSeconds',
    'maxToolCalls',
    'maxRepairs',
    'instructions',
    'skills',
    'admission',
  ]);
  if (p.admission !== undefined) {
    const admission = object(p.admission);
    keys(admission, [
      'maxCpuLoadPerCore',
      'minAvailableRamMiB',
      'maxGpuPercent',
      'minAvailableVramMiB',
    ]);
    for (const [key, limit] of Object.entries(admission)) {
      if (
        typeof limit !== 'number' ||
        !Number.isFinite(limit) ||
        limit < 0 ||
        (key === 'maxGpuPercent' && limit > 100)
      )
        throw new Error('Invalid resource admission limit');
    }
  }
  const result = {
    agent: name(p.agent),
    provider: name(p.provider),
    model: name(p.model),
    runtimeSeconds: p.runtimeSeconds,
    maxToolCalls: p.maxToolCalls,
    maxRepairs: p.maxRepairs,
    ...(p.admission === undefined ? {} : { admission: p.admission }),
    ...Object.fromEntries(
      ['instructions', 'skills']
        .filter((key) => p[key] !== undefined)
        .map((key) => {
          const paths = p[key];
          if (
            !Array.isArray(paths) ||
            paths.length > 32 ||
            paths.some(
              (path: unknown) =>
                typeof path !== 'string' ||
                !/^[\w./-]+$/.test(path) ||
                path.startsWith('/') ||
                path.split('/').includes('..'),
            )
          )
            throw new Error(
              'Instructions and skills must be bounded project-relative paths',
            );
          return [key, paths];
        }),
    ),
  };
  for (const key of ['runtimeSeconds', 'maxToolCalls', 'maxRepairs'] as const) {
    const number = result[key];
    if (
      !Number.isSafeInteger(number) ||
      (number as number) < (key === 'maxRepairs' ? 0 : 1) ||
      (number as number) >
        { runtimeSeconds: 3600, maxToolCalls: 1000, maxRepairs: 3 }[key]
    ) {
      throw new Error(
        'Profile limits must be finite nonnegative integers (runtime/tools positive)',
      );
    }
  }
  return result as Profile;
}
export function readProject(path: string): Project {
  const text = readFileSync(path, 'utf8');
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    throw new Error('Project configuration is not valid JSON');
  }
  const p = object(data);
  keys(p, [
    'repository',
    'taskRoot',
    'validation',
    'serviceRefs',
    'defaultProfile',
    'profiles',
    'allowedOverrides',
  ]);
  const repository = name(p.repository);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error('Expected owner/repository');
  if (typeof p.taskRoot !== 'string' || !p.taskRoot.trim())
    throw new Error('Missing taskRoot');
  const taskRoot = isAbsolute(p.taskRoot)
    ? p.taskRoot
    : resolve(dirname(path), p.taskRoot);
  if (
    !Array.isArray(p.validation) ||
    !p.validation.length ||
    p.validation.some(
      (command: unknown) =>
        !Array.isArray(command) ||
        !command.length ||
        command.some((arg: unknown) => typeof arg !== 'string' || !arg.length),
    )
  ) {
    throw new Error('validation must contain nonempty argument arrays');
  }
  const serviceRefs = Object.fromEntries(
    Object.entries(object(p.serviceRefs)).map(([key, value]) => [
      name(key),
      name(value),
    ]),
  );
  const profiles = Object.fromEntries(
    Object.entries(object(p.profiles)).map(([key, value]) => [
      name(key),
      validateProfile(value),
    ]),
  );
  const defaultProfile = name(p.defaultProfile);
  if (!Object.hasOwn(profiles, defaultProfile))
    throw new Error('Default profile does not exist');
  if (
    !Array.isArray(p.allowedOverrides) ||
    p.allowedOverrides.some(
      (key: unknown) =>
        typeof key !== 'string' ||
        ![
          'agent',
          'provider',
          'model',
          'runtimeSeconds',
          'maxToolCalls',
          'maxRepairs',
        ].includes(key),
    )
  ) {
    throw new Error('Invalid allowedOverrides');
  }
  return {
    repository,
    taskRoot,
    validation: p.validation as string[][],
    serviceRefs,
    defaultProfile,
    profiles,
    allowedOverrides: p.allowedOverrides as (keyof Profile)[],
  };
}
export function resolveProfile(
  project: Project,
  selected?: string,
  overrides: Overrides = {},
): Profile {
  const selectedName = selected ?? project.defaultProfile;
  if (!Object.hasOwn(project.profiles, selectedName))
    throw new Error('Unknown execution profile');
  if (
    Object.keys(overrides).some(
      (key) => !project.allowedOverrides.includes(key as keyof Profile),
    )
  ) {
    throw new Error('Task override is not permitted by project configuration');
  }
  return validateProfile({ ...project.profiles[selectedName], ...overrides });
}
