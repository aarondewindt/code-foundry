import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { within } from '../environment/system.js';
import type { ExecutionRecord } from '../execution/controller.js';
import { executionLock } from '../execution/lock.js';
import type { QueueStore } from '../queue/store.js';

export function reviewPackage(
  store: QueueStore,
  id: string,
  output: string,
  pr?: string,
) {
  const unlock = executionLock(store.path);
  try {
    const task = store.get(id);
    const environment = store.environment(id);
    const candidate = store.latestExecution(id) as ExecutionRecord | null;
    if (
      task.status !== 'candidate-ready' ||
      !environment ||
      !candidate?.reviewSha256
    )
      throw new Error(
        'A candidate with a captured review snapshot is required',
      );
    output = join(realpathSync(dirname(output)), basename(output));
    if (within(task.project.taskRoot, output))
      throw new Error('Store review packages outside the task worker mount');
    const raw = readFileSync(
      join(candidate.artifacts, 'review-snapshot.stdout'),
    );
    if (
      createHash('sha256').update(raw).digest('hex') !== candidate.reviewSha256
    )
      throw new Error('Review snapshot digest mismatch');
    const snapshot = JSON.parse(raw.toString()) as unknown;
    const attempts = store.executions(id) as ExecutionRecord[];
    const reviews = store.reviews(id);
    const prContext = pr ? pullRequest(task.repository, pr) : undefined;
    const data = {
      version: 1,
      taskId: id,
      attemptId: candidate.attemptId,
      candidateSha256: candidate.reviewSha256,
      issue: task.issue,
      acceptanceCriteria: task.issue.body.split(/\r?\n/).flatMap((line) => {
        const criterion = /^\s*[-*] \[([ xX])\] (.+)$/.exec(line);
        return criterion
          ? [{ text: criterion[2], issueChecked: criterion[1] !== ' ' }]
          : [];
      }),
      baseCommit: environment.base,
      candidate: snapshot,
      executionHistory: attempts.map((attempt) => ({
        attemptId: attempt.attemptId,
        resumedFrom: attempt.resumedFrom,
        correction: attempt.correction,
        outcome: attempt.outcome,
        unresolved: attempt.unresolved,
        rounds: attempt.rounds.map(({ summary, validation }) => ({
          implementationSummary: summary,
          validation,
        })),
        supplementary: { tool: 'OpenCode', session: attempt.session },
      })),
      reviews,
      reviewStatus:
        reviews.find((review) => review.attemptId === candidate.attemptId)
          ?.decision ?? 'pending',
      prContext,
      prSummary: {
        title: task.issue.title,
        issue: task.issue.url,
        summary: candidate.rounds.at(-1)?.summary,
        validation: candidate.rounds.at(-1)?.validation,
        unresolved: candidate.unresolved,
      },
    };
    writeFileSync(output, JSON.stringify(data, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    return {
      output,
      attemptId: data.attemptId,
      candidateSha256: data.candidateSha256,
    };
  } finally {
    unlock();
  }
}

function pullRequest(repo: string, number: string): unknown {
  if (!/^[1-9]\d*$/.test(number) || !Number.isSafeInteger(Number(number)))
    throw new Error('Expected a positive pull request number');
  try {
    return JSON.parse(
      execFileSync(
        'gh',
        [
          'pr',
          'view',
          number,
          '--repo',
          repo,
          '--json',
          'number,url,title,state,reviewDecision,statusCheckRollup,reviews',
        ],
        {
          encoding: 'utf8',
          timeout: 15000,
          maxBuffer: 2 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ),
    ) as unknown;
  } catch {
    throw new Error(
      'GitHub PR context unavailable with current read permissions',
    );
  }
}
