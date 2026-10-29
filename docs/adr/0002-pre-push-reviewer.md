# ADR-0002: Pre-push review is a routed, read-only workflow that blocks on `high`

Status: accepted

## Context

A remote review finds a real defect on most rounds, and each round costs a push, a wait and a fix. A reviewer that reads the branch before the push moves that cost earlier. An advisory review is skipped under time pressure, so the push hook requires one.

This is a **workflow, not an agent**: the path is fixed (gather, route, review once, report). It uses two patterns: **routing** (a script picks the model by the kind of change) and a single **read-only reviewer** call. It is not an evaluator-optimizer loop: the reviewer does not feed a fixer. A fix is the author's decision and a new commit, which needs the gates again.

## Decision

- **`bin/pre-push-review.ts prepare [dir]`** (a script, no model) fetches, finds the merge base with `origin/main`, writes the unified diff of `HEAD` against it under the state directory, and prints JSON: commits, changed files and line counts, the model to use and why, the rule files to read (`CLAUDE.md`, `intent.md`, `spec.md`, `plan.md` where they exist) and warnings. It refuses when there is nothing beyond `origin/main`. Every git call has a one minute limit and credential prompts are off; a call that times out stops the run. Only the fetch may fail, and then it warns that `origin/main` may be stale. It parses stdout alone and turns off rename detection, so a file moved out of a sensitive path still counts as a change to that path.
- **Routing** (`src/review/classify.ts`): the stronger model for a diff of 200 or more changed lines, or one that touches a decision record, `CLAUDE.md`, a CI workflow, or an agent, skill or hook definition, or any path in the repo's `sensitivePaths`. The cheaper model otherwise. A miss on those paths costs more than the model difference saves.
- **The reviewer** (`agents/pre-push-reviewer.md`) has the tools `Read`, `Grep` and `Glob` only. A test fails if any agent definition gains another tool. It reports at most ten findings with severity, `file:line`, the evidence it checked and a fix, does not repeat what CI catches, says plainly when it finds nothing, and ends with one `VERDICT:` line of counts.
- **The skill** (`skills/pre-push-review/SKILL.md`) is the chain: prepare, state the cost, review, handle the findings, log, push. The gate runner prints "Next: run the pre-push review" when the gates pass.
- **`high` blocks.** `pre-push-review log` appends one numbers-only line per review to `pre-push-review-log.jsonl` in the state directory. The push hook refuses a push unless the latest line for the repo at `HEAD` has zero `high` findings. `medium` is fixed or answered in the PR; `low` is optional. Fixing a finding is a new commit, so the review runs again.
- **Cost control.** A diff of 1500 or more lines is flagged `large` and the skill stops for a split or the owner's approval. After two rounds it asks the owner whether to continue.

## Consequences

- **The record is self-reported.** Claude logs the counts the reviewer printed, so nothing stops a false `--high 0`. The owner's diff review and the remote review are the backstop; the log shows the pattern.
- **The review is only as good as its reading.** It sees the diff and the repo it runs in, so it is told to say what it could not check. It can be wrong; the skill has the author verify each `high` and `medium` finding before acting. An owner override is recorded as `--high 0` only with the owner's yes, and said so in the PR.
- **It costs real money per push.** The log of numbers shows how often it finds something. If it rarely does, narrow the routing; do not drop the block without a decision.
- **Agents and skills are copied or symlinked** into `~/.claude` (or a repo's `.claude/`) by the user. The tools never touch them.
- The diff files in the state directory contain code and stay local; nothing uploads them.
