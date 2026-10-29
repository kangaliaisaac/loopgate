# pre-push review

Reviews the commits a branch is about to push, before the push costs a CI round and a review round. Design: [ADR-0002](adr/0002-pre-push-reviewer.md).

Order for a change: `node bin/ci-gate-runner.ts` (the gates), then the review, then `git push`. The push hook enforces both. The gate runner ends with "Next: run the pre-push review" when it passes.

- **Skill:** `pre-push-review` drives the review (prepare, state the cost, run the agent, handle the findings, log, push). Copy or symlink it and the `pre-push-reviewer` agent into `~/.claude` (or the repo's `.claude/`).
- **`node bin/pre-push-review.ts prepare [dir]`** prints JSON about the push (commits, files, changed lines, the model to use and why, rule files, warnings) and writes the diff to `diffPath` under the state directory. It stops when there is nothing beyond `origin/main`.
- **`node bin/pre-push-review.ts log --repo R --head SHA --model opus|sonnet --lines N --high N --medium N --low N`** appends one numbers-only line to `pre-push-review-log.jsonl` in the state directory.
- **Model:** the stronger model for 200 or more changed lines or any change to a decision record, `CLAUDE.md`, a workflow, an agent, skill or hook, or a path in the repo's `sensitivePaths`; the cheaper one otherwise. A diff of 1500 or more lines is flagged: split it or get the owner's approval first.
- **It blocks on `high`.** The push hook refuses a push until the latest review logged for `HEAD` has zero `high` findings. `medium` is fixed or answered in the PR. The reviewer is read-only (`Read`, `Grep`, `Glob`) and never edits.
