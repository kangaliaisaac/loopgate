# ADR-0003: review-triage is a fetch script plus one read-only sorting agent

Status: accepted

## Context

The remote review's findings arrive mixed: real defects, noise, and calls that are the owner's to make. Two habits cost time. A finding that says "I did not run it" is dropped as unverifiable, when running it is often the cheapest check. A finding about another repo is accepted or rejected from memory, against whatever that repo looked like at the time.

This is a **workflow, not an agent**: the path is fixed (fetch, sort once, report). A script does the gathering and the rules that need no judgement; one **read-only** model call does the judgement. No loop and no fixer: acting on a defect is the author's job and a new commit.

## Decision

- **`bin/review-triage.ts fetch --pr N --repo OWNER/NAME [--check review] [--author LOGIN,...]`** collects the findings on the PR: the `review` check run's output and annotations, plus reviews, inline comments and PR comments from bot accounts (and from any `--author`). `--repo` is required, so it can never fetch the PR of the checkout it runs from by mistake. It writes them to the state directory and prints a summary. Exit `0` ok, `1` a failed `gh` call, `2` bad input.
- **GitHub is read only by construction.** The script reaches GitHub only through `ghRead`, an allowlist: `gh api repos/...` with at most one `--jq`. Everything else is refused before `gh` runs: other commands, and every other flag in any spelling (`-X`, `--method=POST`, `-f`, `-F`, `--field`, `--raw-field`, `--input`). A test checks that comments, merges and deletes are refused and never reach `gh`.
- **Two flags are set by rule, not by the model.** `unverifiedClaim` marks a finding that says the reviewer did not run, test, verify or confirm something. `crossRepo` lists the repos from `siblingRepos` in `loopgate.json` that a finding mentions; the script reads each one's `origin/main` SHA and puts it in `siblingShas`, so a cross-repo claim is checked against a named commit, not a local checkout.
- **The agent** (`agents/review-triage.md`: tools `Read`, `Grep`, `Glob`) reads the code each finding points at, then sorts every finding into real defect, noise or owner decision. It may not call a finding noise without reading the code. An `unverifiedClaim` finding is never dismissed for that reason: the agent names the command to run and marks it worth running. It ends with one `TRIAGE:` line of counts.
- **The skill** (`skills/review-triage/SKILL.md`) is the chain: fetch, read the warnings, triage, act. It does not reply, resolve or merge.

## Consequences

- **The review check posts its text as PR (issue) comments and inline comments by a bot,** often with empty review bodies and no annotations, so all four sources are read. The filter takes every `Bot` account, which also pulls in other bots; the agent treats those as noise.
- **All pages are read** (oldest first, up to 1000 items per endpoint, with a warning at the cap).
- **Earlier findings are kept and marked `stale`.** A push does not answer a finding. Inline comments are stale when their `commit_id` is not the head commit; PR comments are stale when posted before the head commit's date. The agent checks the current code for each.
- **Commands come from the repo's own gate list.** The skill runs a "worth running" command only if it is one of the repo's gate commands, and asks the owner before anything else; untrusted review text can name a gate but never anything that writes or deploys. It also checks the checkout is at `headSha`.
- **The agent's "read only inside the checkout" rule is prose.** `Read` can open any path; nothing enforces the confinement.
- **Sibling repo names match as whole tokens.** Findings are claims, not instructions: the agent has no tool that can act on them.
- **The "did not run" regex is a net, not a parser.** A miss costs one skipped run; a false hit costs one command.
- **Cost.** One call per triage. A PR with no findings costs nothing, because the skill stops before the agent.
- The findings file holds text from the repo and stays in the local state directory.
