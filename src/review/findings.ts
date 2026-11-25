import { object, keys } from '../queue/config.js';

const severities = ['blocking', 'major', 'minor', 'note'] as const;
const kinds = [
  'code',
  'design',
  'specification',
  'permission',
  'paid-implementation',
] as const;

function choice<T extends string>(value: unknown, allowed: readonly T[]): T {
  const match = allowed.find((entry) => entry === value);
  if (!match) throw new Error('Invalid review classification');
  return match;
}

function bounded(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error('Review text is missing or exceeds its limit');
  return value;
}

function references(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 10)
    throw new Error('Invalid review references');
  return value.map((reference: unknown) => bounded(reference, 300));
}

export function parseReview(value: unknown) {
  const input = object(value);
  keys(input, [
    'attemptId',
    'candidateSha256',
    'reviewer',
    'decision',
    'summary',
    'findings',
    'profile',
  ]);
  const attemptId = bounded(input.attemptId, 36);
  const candidateSha256 = bounded(input.candidateSha256, 64);
  if (
    !/^[a-f0-9-]{36}$/.test(attemptId) ||
    !/^[a-f0-9]{64}$/.test(candidateSha256)
  )
    throw new Error('Invalid candidate identity');
  const decision = choice(input.decision, [
    'accepted',
    'changes-requested',
  ] as const);
  if (
    !Array.isArray(input.findings) ||
    input.findings.length > 12 ||
    (decision === 'accepted'
      ? input.findings.length !== 0
      : input.findings.length === 0)
  )
    throw new Error('Review findings must match the decision');
  const findings = input.findings.map((value: unknown) => {
    const finding = object(value);
    keys(finding, [
      'severity',
      'kind',
      'files',
      'criteria',
      'explanation',
      'request',
    ]);
    const files = references(finding.files);
    const criteria = references(finding.criteria);
    if (!files.length && !criteria.length)
      throw new Error('Each finding needs a file or criterion reference');
    return {
      severity: choice(finding.severity, severities),
      kind: choice(finding.kind, kinds),
      files,
      criteria,
      explanation: bounded(finding.explanation, 1000),
      request: bounded(finding.request, 1000),
    };
  });
  const metadata =
    input.profile === undefined ? undefined : object(input.profile);
  if (metadata)
    keys(metadata, [
      'name',
      'provider',
      'model',
      'interface',
      'scope',
      'approvedBudget',
    ]);
  const budget =
    metadata?.approvedBudget === undefined
      ? undefined
      : object(metadata.approvedBudget);
  if (budget) {
    keys(budget, ['currency', 'maxMinorUnits']);
    if (
      typeof budget.currency !== 'string' ||
      !/^[A-Z]{3}$/.test(budget.currency) ||
      typeof budget.maxMinorUnits !== 'number' ||
      !Number.isSafeInteger(budget.maxMinorUnits) ||
      budget.maxMinorUnits < 0
    )
      throw new Error('Invalid reviewer budget metadata');
  }
  const profile = metadata && {
    name: bounded(metadata.name, 100),
    provider: bounded(metadata.provider, 100),
    ...(metadata.model === undefined
      ? {}
      : { model: bounded(metadata.model, 100) }),
    interface: choice(metadata.interface, ['manual'] as const),
    scope: choice(metadata.scope, ['package-only'] as const),
    ...(budget ? { approvedBudget: budget } : {}),
  };
  const result = {
    attemptId,
    candidateSha256,
    reviewer: bounded(input.reviewer, 300),
    decision,
    summary: bounded(input.summary, 3000),
    findings,
    ...(profile ? { profile } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 16000)
    throw new Error('Review exceeds the correction input budget');
  return result;
}

export type ReviewInput = ReturnType<typeof parseReview>;
export type Review = ReviewInput & { id: string; recordedAt: string };
export interface Correction {
  review: Review;
  approvedBy: string;
  baselineVerified?: true;
}
