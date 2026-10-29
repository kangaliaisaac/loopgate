# review-triage

Sorts the findings of the CI `review` check on a PR into real defects, noise and decisions only the owner can make. Design: [ADR-0003](adr/0003-review-triage.md).

- **Skill:** `review-triage` drives it (fetch, triage, act). Copy or symlink it and the `review-triage` agent into `~/.claude` (or the repo's `.claude/`).
- **`node bin/review-triage.ts fetch --pr N --repo OWNER/NAME [--check review] [--author LOGIN,...]`** (`--repo` is required) reads the check run's output and annotations, and bot (or `--author`) reviews, inline comments and PR comments (all pages), writes them to `review-triage/<repo>-pr<N>.json` in the state directory and prints a summary. Each finding carries `stale` (posted before the head commit), `unverifiedClaim` ("I did not run it") and `crossRepo`; `siblingShas` holds the `origin/main` SHA of each repo from `siblingRepos` in `loopgate.json` that a finding mentions.
- **Read only.** Only `gh api repos/...` GETs run, with at most one `--jq`; anything that could comment, resolve or merge is refused before `gh` starts. The agent has `Read`, `Grep` and `Glob`.
- Reads up to 1000 items per endpoint and warns at the cap. Exit `1` is a failed `gh` call, `2` bad input.
