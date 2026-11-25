# Independent candidate review

[Issue #7](https://github.com/aarondewindt/code-foundry/issues/7) specifies the
local review workflow. An execution that reaches `candidate-ready` still
requires independent review.

## Export and inspect a candidate

```sh
node dist/cli.js review-package TASK_ID --output /private/review-1.json --db /private/state.sqlite
```

The command creates a new private JSON file outside the worker's task root. It
includes the approved issue, its checkbox criteria, the base commit, the Git
patch and changed files, local commit references, validation results,
implementation summaries, unresolved concerns and earlier decisions. OpenCode
session IDs are supplementary. The patch contains Git-visible worktree changes
including non-ignored untracked files. The review snapshot uses a temporary Git
index and object directory. The worktree, real index and Git history remain
intact. B2's readiness check still enforces the prepared branch and base. A
candidate produced before review snapshots were added lacks this evidence.

Inspect the package before sharing it with a person or with a manual
ChatGPT/Codex or Claude session. A source patch or issue may contain sensitive
material. For a related pull request in the configured repository, optionally
add `--pr NUMBER` to read its metadata, reviews and CI status through the
operator's existing `gh` access. The package includes a draft PR summary.

## Record findings and authorize correction

Create a local JSON file using the package's `attemptId` and `candidateSha256`.
Use one independent decision per attempt.

```json
{
  "attemptId": "00000000-0000-0000-0000-000000000000",
  "candidateSha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "reviewer": "Independent reviewer",
  "decision": "changes-requested",
  "summary": "The implementation omits the specified bounds check.",
  "findings": [
    {
      "severity": "major",
      "kind": "code",
      "files": ["src/clamp.ts"],
      "criteria": ["Clamp values to the inclusive bounds"],
      "explanation": "The lower bound is not applied.",
      "request": "Apply the lower bound and preserve the existing behavior for valid values."
    }
  ]
}
```

Severity can be `blocking`, `major`, `minor` or `note`. Use a file or an issue
criterion to locate each finding. Use `accepted` with an empty findings array to
record acceptance. Use `design`, `specification`, `permission` or
`paid-implementation` instead of `code` to flag a decision that needs human
resolution. Those findings keep a correction from starting.

```sh
node dist/cli.js record-review TASK_ID --file /private/findings.json --db /private/state.sqlite
node dist/cli.js correct TASK_ID --review REVIEW_ID --approved-by "Maintainer decision" --db /private/state.sqlite
node dist/cli.js review-package TASK_ID --output /private/review-2.json --db /private/state.sqlite
```

Correction revalidates the approved issue and the restricted environment,
compares the current worktree snapshot to the reviewed candidate, and starts a
new bounded OpenCode attempt on the retained worktree. A correction uses a fresh
native session and receives only the authorized code findings as correction
scope. Configured validation runs again. The next package includes the earlier
attempt and review and starts with a pending review decision. Acceptance is a
local record. GitHub publication and changes to issue state remain operator
actions.

Manual findings may include optional `profile` metadata with `name`, `provider`,
`model`, `interface: "manual"`, `scope: "package-only"`, and an optional
`approvedBudget` containing `currency` and `maxMinorUnits`. This describes an
operator-selected review. A future reviewer backend can use these fields to
resolve its interface and enforce its scope and budget. Current commands make
no reviewer API calls.

The representative verification mode uses a restricted disposable environment,
the pinned OpenCode binary and scripted model responses.

```sh
CF_INTEGRATION_IMAGES=/workspaces/code-foundry/scratch/reviewed-images.tar yarn test:integration --review
```

The [C1 results](experiments/c1/results.json) record the initial finding, the
corrected candidate's passing validation and its pending independent review.
