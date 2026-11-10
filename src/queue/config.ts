import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

export interface Profile {
  agent: string;
  provider: string;
  model: string;
  runtimeSeconds: number;
  maxToolCalls: number;
  maxRepairs: number;
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
function profile(value: unknown): Profile {
  const p = object(value);
  keys(p, [
    'agent',
    'provider',
    'model',
    'runtimeSeconds',
    'maxToolCalls',
    'maxRepairs',
  ]);
  const result = {
    agent: name(p.agent),
    provider: name(p.provider),
    model: name(p.model),
    runtimeSeconds: p.runtimeSeconds,
    maxToolCalls: p.maxToolCalls,
    maxRepairs: p.maxRepairs,
  };
  for (const key of ['runtimeSeconds', 'maxToolCalls', 'maxRepairs'] as const) {
    const number = result[key];
    if (
      !Number.isSafeInteger(number) ||
      (number as number) < (key === 'maxRepairs' ? 0 : 1)
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
      profile(value),
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
  return profile({ ...project.profiles[selectedName], ...overrides });
}
