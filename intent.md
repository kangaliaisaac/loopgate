# `loopgate`: intent

## What it is

`loopgate` is a small toolkit that keeps AI-assisted changes honest before they reach a pull request. It is three command-line tools, two Claude Code agents with their skills, one push hook, one reusable GitHub workflow and a small library of the process and git helpers the tools share. It works on any repo, in any language, because it runs the repo's own gate commands instead of knowing them.

## The problem

A coding agent can produce a plausible diff faster than a person can read it. Left alone, three things go wrong:

1. the agent pushes before the gates pass,
2. its own review misses what a second reader would catch,
3. and the pull request becomes the first place anyone looks hard.

Each of those costs a CI round and a review round, and the person who merges pays for it in attention.

## What it does

1. **`ci-gate-runner`** runs the repo's gate commands (format, lint, types, tests, audit, secret scan) in order, stops at the first failure and records a pass for the exact commit.
2. **`pre-push-review`** gathers the branch diff, picks a model by risk, and hands the diff to a read-only reviewer agent that reports defects CI cannot catch. A `high` finding blocks the push until it is fixed or overridden by the owner.
3. **`review-triage`** reads the findings the remote review left on a pull request and sorts them into real defects, noise and decisions only the owner can make.
4. **The push hook** refuses `git push` from Claude Code until the gates and the review are recorded for `HEAD`.
5. **The reusable workflow** runs a read-only Claude review on every push to a pull request in the repos that adopt it.

The flow: change, gates, local review, fix until green, push, remote review, the owner reviews, approves and merges. **`loopgate` never merges**.

## Who it is for

One developer working with an AI assistant across several small repos, who wants the checks enforced by tooling rather than remembered.

## Out of scope

- Merging, approving or labelling pull requests.
- Fixing the code it reviews. Reviewers are read-only.
- Language-specific linting. The repo's own tools do that; `loopgate` only runs them.
- Hosting, secrets management or anything that needs a server.
