# loopgate

Gates and reviews for AI-assisted changes. A coding agent can produce a plausible diff faster than you can read it; loopgate makes the checks happen before the pull request instead of in it.

The loop it enforces:

```
change → gates → local review → fix until green → push → remote review → you review and merge
```

loopgate never merges, approves or labels a pull request. Everything it adds is read-only advice or a refusal; the owner decides.

## What is in it

| Piece             | What it does                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ci-gate-runner`  | Runs the repo's own gate commands (format, lint, types, tests, audit) in order, stops at the first failure, and records a pass for the exact commit.               |
| `pre-push-review` | Gathers the branch diff, picks a model by risk, and hands it to a read-only reviewer agent that reports defects CI cannot catch. A `high` finding blocks the push. |
| `review-triage`   | Reads the findings the remote review left on a pull request and sorts them into real defects, noise and decisions only the owner can make.                         |
| Push hook         | A Claude Code `PreToolUse` hook that refuses `git push` until the gates passed and a review with no `high` finding is recorded for `HEAD`.                         |
| Review workflow   | A reusable GitHub workflow that runs a read-only Claude review on each pull request push.                                                                          |
| Library           | The small process and git helpers the tools share, for other packages. See [docs/library.md](docs/library.md).                                                     |

The tools are language-agnostic: they run the commands in a repo's `loopgate.json`, so they gate a Python, Rust or JavaScript repo alike.

## Use it

Requires Node 24 or later, `git`, and `gh` for review triage. The hook also needs `jq`.

```
git clone https://github.com/kangaliaisaac/loopgate
cd loopgate && npm ci
```

**1. Describe the gates.** Put a `loopgate.json` at the root of the repo to gate (one per repo, committed there). This is loopgate's own:

```json
{
	"gates": [
		{ "name": "prettier", "command": "npx", "args": ["prettier", "--check", "."] },
		{ "name": "test", "command": "npm", "args": ["test"] }
	],
	"environment": { "path": "node_modules", "fix": "run `npm ci`" }
}
```

The keys, and the optional `testDatabaseEnv`, `siblingRepos` and `sensitivePaths`, are in [spec.md](spec.md). A Python repo uses `"command": "./.venv/bin/python", "args": ["-m", "pytest", "-q"]`, or `uv run`.

**2. Run the tools** from the repo being gated (`<loopgate>` is this checkout):

```
node <loopgate>/bin/ci-gate-runner.ts
node <loopgate>/bin/pre-push-review.ts prepare
node <loopgate>/bin/review-triage.ts fetch --pr 12 --repo owner/name
```

**3. Install the agents and skills.** Copy or symlink `agents/*.md` into `~/.claude/agents/` and `skills/*` into `~/.claude/skills/` (or into the repo's `.claude/`). The skills drive the tools; the agents only read.

**4. Wire the hook.** Add it to the repo's untracked `.claude/settings.local.json`:

```json
{
	"hooks": {
		"PreToolUse": [
			{
				"matcher": "Bash",
				"hooks": [{ "type": "command", "command": "sh \"<loopgate>/hooks/pre-push-gate.sh\"" }]
			}
		]
	}
}
```

The hook only covers pushes Claude makes. A push from your own terminal skips it, so make CI the backstop.

**5. Turn on the remote review.** Copy [docs/review-caller.example.yml](docs/review-caller.example.yml) into the repo as `.github/workflows/review.yml`, set `<ref>` to a loopgate tag, and add a `CLAUDE_CODE_OAUTH_TOKEN` repository secret and the Claude Code GitHub App. It reviews same-repository, non-draft pull requests with read-only tools.

## State

Records (gate passes, the review log, diffs, findings) are kept under `LOOPGATE_STATE_DIR`, by default `~/.local/state/loopgate`. They stay local and are never committed.

## Design

[intent.md](intent.md) says what loopgate is for and what it will not do. [spec.md](spec.md) is the contract. The decisions are in [docs/adr](docs/adr).

## Licence

MIT. See [LICENSE](LICENSE).
