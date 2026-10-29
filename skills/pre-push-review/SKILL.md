---
name: pre-push-review
description: Review the commits a branch is about to push, after the local gates pass and before `git push`. Use for every push, and whenever the push hook says no review is recorded for HEAD.
---

# pre-push-review

Order for a change: local gates (format, lint, types, tests), then this review, then `git push`. The push hook refuses a push until a review is recorded for the current `HEAD` with no `high` finding. A new commit makes the record stale, so the loop is: fix, commit, gates, review again.

1. **Prepare.** Run `node <loopgate>/bin/pre-push-review.ts prepare` in the repo (`<loopgate>` is the loopgate checkout). It fetches, diffs `HEAD` against `origin/main`, writes the diff to `diffPath`, and prints JSON: commits, changed files, `lines`, the `model` to use, rule files (`context`) and `warnings`. An error means there is nothing beyond `origin/main` to review.
2. **Check the cost.** If `warnings` says the diff is large, stop and split the branch or ask the owner. Otherwise state the model and line count in one line.
3. **Review.** Start the `pre-push-reviewer` agent with that `model`. Give it `diffPath`, the commit subjects, the changed files and the `context` paths, nothing else. It must not be told what to conclude.
4. **Handle the findings.** Show them to the owner as written. Check each `high` and `medium` yourself before acting; the reviewer can be wrong.
   - `high`: fix it, or show the owner why it is wrong. The hook will not let the push through while one stands.
   - `medium`: fix it, or answer it in the PR description.
   - After two rounds, ask the owner whether to continue.
5. **Record it.** Run `node <loopgate>/bin/pre-push-review.ts log --repo <repo> --head <short sha> --model <model> --lines <lines> --high <h> --medium <m> --low <l>` with the counts from the `VERDICT` line. The record is what the hook reads. Record the real counts, including after an owner override: ask the owner, then record `--high 0` only with their yes, and say so in the PR description.
6. **Push.** Then `git push`. The remote review runs on the PR; the owner reviews and merges.

The agent only reads. Never ask it to fix anything, and never skip the local gates because the review was clean: they check different things.
