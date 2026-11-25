import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EnvironmentManager } from '../../src/environment/manager.js';
import type { Environment } from '../../src/environment/types.js';
import {
  ExecutionController,
  type ExecutionRecord,
} from '../../src/execution/controller.js';
import type { IssueSnapshot } from '../../src/queue/github.js';
import type { QueueStore } from '../../src/queue/store.js';
import { parseReview } from '../../src/review/findings.js';
import { reviewPackage } from '../../src/review/package.js';

export async function verifyReviewCorrection(
  store: QueueStore,
  manager: EnvironmentManager,
  environment: Environment,
  issue: IssueSnapshot,
) {
  const controller = new ExecutionController(store, manager);
  const id = environment.taskId;
  const initial = (await controller.execute(id, issue)) as {
    execution: ExecutionRecord;
  };
  assert.equal(initial.execution.outcome, 'candidate-ready');
  const first = reviewPackage(store, id, '/home/cf/first-review.json');
  const before = JSON.parse(readFileSync(first.output, 'utf8')) as {
    acceptanceCriteria: { text: string }[];
    candidate: { patch: string; changedFiles: string[] };
  };
  assert.ok(before.candidate.changedFiles.includes('clamp.mjs'));
  assert.equal(before.acceptanceCriteria.length, 2);
  assert.doesNotMatch(before.candidate.patch, /inclusive bounds/);
  const finding = store.recordReview(
    id,
    parseReview({
      attemptId: first.attemptId,
      candidateSha256: first.candidateSha256,
      reviewer: 'Independent representative fixture review',
      decision: 'changes-requested',
      summary:
        'The implementation passes validation but omits the required bounds comment.',
      findings: [
        {
          severity: 'minor',
          kind: 'code',
          files: ['clamp.mjs'],
          criteria: [before.acceptanceCriteria[1]!.text],
          explanation:
            'The exported change contains no inclusive bounds comment.',
          request:
            'Add the required inclusive bounds source comment to clamp.mjs.',
        },
      ],
    }),
  );
  const corrected = (await controller.correct(
    id,
    issue,
    finding.id,
    'Representative fixture correction approval',
  )) as { execution: ExecutionRecord };
  assert.equal(corrected.execution.outcome, 'candidate-ready');
  assert.notEqual(initial.execution.session, corrected.execution.session);
  const second = reviewPackage(store, id, '/home/cf/second-review.json');
  const after = JSON.parse(readFileSync(second.output, 'utf8')) as {
    candidate: { patch: string };
    reviewStatus: string;
    reviews: { id: string }[];
    executionHistory: { attemptId: string }[];
  };
  assert.notEqual(first.candidateSha256, second.candidateSha256);
  assert.match(after.candidate.patch, /inclusive bounds/);
  assert.equal(after.reviewStatus, 'pending');
  assert.equal(after.reviews[0]?.id, finding.id);
  assert.deepEqual(
    after.executionHistory.map(({ attemptId }) => attemptId),
    [first.attemptId, second.attemptId],
  );
  for (const attempt of [initial.execution, corrected.execution])
    assert.ok(
      attempt.rounds
        .at(-1)
        ?.validation.every(({ result }) => result.exit === 0),
    );
  assert.equal(
    readFileSync(join(environment.worktree, 'clamp.test.mjs'), 'utf8'),
    readFileSync(join(environment.config.source, 'clamp.test.mjs'), 'utf8'),
  );
  writeFileSync(
    '/home/cf/execution-report.json',
    JSON.stringify(
      {
        scope: 'Real pinned OpenCode with scripted synthetic model responses',
        initialCandidateSha256: first.candidateSha256,
        correctedCandidateSha256: second.candidateSha256,
        independentFindingRecorded: true,
        correctedOutcome: corrected.execution.outcome,
        validationExits: corrected.execution.rounds
          .at(-1)
          ?.validation.map(({ result }) => result.exit),
        secondReviewStatus: after.reviewStatus,
        earlierAttemptAndReviewRetained: true,
        testFilePreserved: true,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}
