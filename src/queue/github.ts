import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { object } from './config.js';

export interface IssueRef {
  repository: string;
  number: number;
}
export interface Blocker {
  repository: string;
  number: number;
  state: string;
}
export interface IssueSnapshot extends IssueRef {
  url: string;
  title: string;
  body: string;
  state: string;
  labels: string[];
  comments: { author: string; body: string }[];
  milestone: { number: number; title: string } | null;
  blockers: Blocker[];
  dependenciesVerified: boolean;
  dependencyLimitation: string | null;
  fetchedAt: string;
}
export type Request = (endpoint: string) => unknown;
export function parseIssue(input: string, repository: string): IssueRef {
  const url =
    /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9]\d*)\/?$/.exec(
      input,
    );
  const short = /^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/.exec(input);
  const ref = url ?? short;
  const number = Number(ref?.[2] ?? (/^[1-9]\d*$/.test(input) ? input : NaN));
  const ownerRepo = ref?.[1] ?? repository;
  if (
    ownerRepo.toLowerCase() !== repository.toLowerCase() ||
    !Number.isSafeInteger(number)
  ) {
    throw new Error(
      'Issue must belong to the configured repository and have a positive number',
    );
  }
  return { repository, number };
}
export const ghRequest: Request = (endpoint) => {
  try {
    const output = execFileSync(
      'gh',
      [
        'api',
        '--method',
        'GET',
        '-H',
        'Accept: application/vnd.github+json',
        endpoint,
      ],
      {
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return JSON.parse(output) as unknown;
  } catch (error) {
    const failure = error as {
      stderr?: string | Buffer;
      status?: number;
      code?: string;
    };
    const detail = String(failure.stderr ?? '');
    let reason = 'network, response or API failure';
    if (
      failure.status === 4 ||
      /auth login|authentication|HTTP 401/i.test(detail)
    )
      reason = 'authentication required';
    else if (/HTTP (403|429)|rate limit/i.test(detail))
      reason =
        'permission denied or rate limited; retry after checking GitHub access';
    else if (/HTTP 404/i.test(detail))
      reason = 'resource unavailable or not permitted';
    else if (failure.code === 'ETIMEDOUT') reason = 'request timed out';
    else if (failure.code === 'ENOENT') reason = 'gh is not installed';
    // Never forward raw stderr, headers, credentials or response bodies into logs.
    // eslint-disable-next-line preserve-caught-error -- Raw gh errors can contain credentials; discard them deliberately.
    throw new Error(`GitHub read failed: ${reason}`);
  }
};
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error('Invalid GitHub number');
  return value;
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid GitHub text');
  return value;
}
function state(value: unknown): string {
  if (value !== 'open' && value !== 'closed')
    throw new Error('Invalid GitHub issue state');
  return value;
}
function pages(request: Request, endpoint: string): unknown[] {
  const values: unknown[] = [];
  for (let page = 1; page <= 100; page++) {
    const data = request(`${endpoint}?per_page=100&page=${page}`);
    if (!Array.isArray(data)) throw new Error('Expected a GitHub list');
    values.push(...data);
    if (data.length < 100) return values;
  }
  throw new Error('GitHub pagination limit reached');
}
export function fetchIssue(
  ref: IssueRef,
  request: Request = ghRequest,
): IssueSnapshot {
  const root = `repos/${ref.repository}`;
  const permission = object(object(request(root)).permissions);
  if (permission.pull !== true)
    throw new Error('Repository read permission could not be verified');
  const data = object(request(`${root}/issues/${ref.number}`));
  if (data.pull_request || integer(data.number) !== ref.number)
    throw new Error('Expected the requested issue, not a pull request');
  const body = data.body === null ? '' : string(data.body);
  if (!Array.isArray(data.labels)) throw new Error('Expected GitHub labels');
  const labels = data.labels.map((label: unknown) =>
    string(object(label).name),
  );
  const comments = pages(request, `${root}/issues/${ref.number}/comments`).map(
    (value) => {
      const comment = object(value);
      return {
        author: string(object(comment.user).login),
        body: string(comment.body),
      };
    },
  );
  let milestone: IssueSnapshot['milestone'] = null;
  if (data.milestone !== null) {
    const value = object(data.milestone);
    milestone = { number: integer(value.number), title: string(value.title) };
  }
  const blockers = new Map<string, Blocker>();
  let dependencyLimitation: string | null = null;
  const add = (repository: string, number: number, issueState: string) => {
    blockers.set(`${repository.toLowerCase()}#${number}`, {
      repository,
      number,
      state: issueState,
    });
  };
  try {
    for (const value of pages(
      request,
      `${root}/issues/${ref.number}/dependencies/blocked_by`,
    )) {
      const blocker = object(value);
      const link = string(blocker.html_url);
      // Never follow cross-project links or arbitrary issue-provided URLs.
      const target = parseIssue(link, ref.repository);
      add(target.repository, target.number, state(blocker.state));
    }
    // Existing roadmap dependencies are also maintained in the specification body.
    const section =
      /^## Blocked by\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/im.exec(body)?.[1] ??
      '';
    for (const match of section.matchAll(
      /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9]\d*)/g,
    )) {
      const target = parseIssue(match[0], ref.repository);
      if (
        !blockers.has(`${target.repository.toLowerCase()}#${target.number}`)
      ) {
        const dependency = object(request(`${root}/issues/${target.number}`));
        add(target.repository, target.number, state(dependency.state));
      }
    }
    const entries = section
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    for (const entry of entries) {
      const explicitlyNone = /^none(?:\s|[.—-]|$)/i.test(entry);
      if (
        !explicitlyNone &&
        !entry.includes('https://github.com/') &&
        (entry.startsWith('-') || blockers.size === 0)
      ) {
        throw new Error(
          'Blocking dependencies could not be resolved from the specification',
        );
      }
    }
  } catch {
    dependencyLimitation =
      'Blocking dependency information is incomplete or inaccessible; admission and claims are blocked';
  }
  return {
    ...ref,
    url: `https://github.com/${ref.repository}/issues/${ref.number}`,
    title: string(data.title),
    body,
    state: state(data.state),
    labels,
    comments,
    milestone,
    blockers: [...blockers.values()],
    dependenciesVerified: dependencyLimitation === null,
    dependencyLimitation,
    fetchedAt: new Date().toISOString(),
  };
}
export function specificationHash(issue: IssueSnapshot): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        title: issue.title,
        body: issue.body,
        labels: issue.labels,
        comments: issue.comments,
        milestone: issue.milestone,
      }),
    )
    .digest('hex');
}
export function blockedReason(issue: IssueSnapshot): string | null {
  if (!issue.dependenciesVerified)
    return issue.dependencyLimitation ?? 'Dependencies not verified';
  if (issue.state !== 'open') return 'Issue is not open';
  if (issue.blockers.some((blocker) => blocker.state !== 'closed'))
    return 'Unresolved GitHub blockers';
  return null;
}
