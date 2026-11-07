# `loopgate`

Gates and reviews for AI-assisted changes. A coding agent can produce a plausible diff faster than you can read it. `loopgate` makes the checks happen before the pull request instead of in it.

The loop it enforces:

```
change → gates → local review → fix until green → push → remote review → the owner reviews and mergees
```

`loopgate` never merges, approves or labels a pull request. Everything it adds is read-only advice or a refusal; the owner decides.

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

```bash
git clone https://github.com/kangaliaisaac/loopgate
cd loopgate && npm ci
```

**1. Describe the gates.** 

Put a `loopgate.json` at the root of the repo to gate (one per repo, committed there). This is loopgate's own:

```json
{
	"gates": [
		{
			"name": "prettier",
			"command": "npx",
			"args": ["prettier", "--check", "."]
		},
		{
			"name": "test",
			"command": "npm",
			"args": ["test"]
		}
	],
	"environment": {
		"path": "node_modules",
		"fix": "run `npm ci`"
	}
}
```

The keys, and the optional `testDatabaseEnv`, `siblingRepos` and `sensitivePaths`, are in [spec.md](spec.md). 

A Python repo gates like this (with `uv run --no-sync` so the gates work without the venv on `PATH`):

```json
{
	"gates": [
		{ 
			"name": "ruff", 
			"command": "uv", 
			"args": [
				"run", 
				"--no-sync", 
				"ruff", 
				"check", 
				"."
			] 
		},
		{
			"name": "format",
			"command": "uv",
			"args": [
				"run", 
				"--no-sync", 
				"ruff", 
				"format", 
				"--check", 
				"."
			]
		},
		{ 
			"name": "mypy", 
			"command": "uv", 
			"args": [
				"run", 
				"--no-sync", 
				"mypy", 
				"src"
			] 
		},
		{ 
			"name": "test", 
			"command": "uv", 
			"args": [
				"run", 
				"--no-sync", 
				"pytest", 
				"-q"
			] 
		}
	]
}
```

The runner records a pass per commit, so the repo needs at least one commit first.

**2. Run the tools** from the repo being gated (`<loopgate>` is this checkout):

```
node <loopgate>/bin/ci-gate-runner.ts
node <loopgate>/bin/pre-push-review.ts prepare
node <loopgate>/bin/review-triage.ts fetch --pr 12 --repo owner/name
```

**3. Install the agents and skills.** 

Copy or symlink `agents/*.md` into `~/.claude/agents/` and `skills/*` into `~/.claude/skills/` (or into the repo's `.claude/`). 

The skills drive the tools; the agents only read.

**4. Wire the hook.** 

Add it to the repo's untracked `.claude/settings.local.json`:

```json
{
	"hooks": {
		"PreToolUse": [
			{
				"matcher": "Bash",
				"hooks": [
					{
						"type": "command",
						"command": "sh \"<loopgate>/hooks/pre-push-gate.sh\""
					}
				]
			}
		]
	}
}
```

The hook only covers pushes Claude makes. A push from your own terminal skips it, so make CI the backstop.

**5. Turn on the remote review.** 

Copy [docs/review-caller.example.yml](docs/review-caller.example.yml) into the repo as `.github/workflows/review.yml`, keep or bump the `@v0.1.0` tag, and add a `CLAUDE_CODE_OAUTH_TOKEN` repository secret and the Claude Code GitHub App. 

It reviews same-repository, non-draft pull requests with read-only tools.

## How not to use it

- **It is not a security boundary.** 
  
  The push hook reads the command Claude is about to run and refuses a push it can tell is unsafe. It is a scanner with known limits: a conditional `cd`, an alias, `echo '...' | sh`, and a `git`, `pushd` or `GIT_DIR` form hidden inside a quoted script can slip past it, and a command that merely mentions a push in its text can be refused. Treat it as a guardrail for an agent that is trying to follow the rules, not a defence against one that is not.
- **It only covers pushes Claude makes.** 
  
  A push from your own terminal skips the hook. Make CI the backstop: require the `review` check and the gates on the branch.
- **The review record is self-reported.** 
  
  The agent records its own review; nothing proves it ran. That is why CI repeats the gates and the remote review runs on the pull request.
- **Do not run the gate runner on a repo you do not trust.** 
  
  It runs the commands in that repo's `loopgate.json`, which can be anything.
- **It advises and refuses; it never decides.** 
  
  It does not merge, approve or label a pull request, and a clean review is not a substitute for reading the diff yourself.
- **Do not put secrets or private data in `loopgate.json`, gate output or the review state.** 
  
  The records are local and uncommitted, but they are plain files, and the reviewer reads whatever the diff contains.
- **The remote review is narrow on purpose.** 
  
  It reviews same-repository, non-draft pull requests with read-only tools, and skips Dependabot pull requests. It is not a general code scanner.

## State

Records (gate passes, the review log, diffs, findings) are kept under `LOOPGATE_STATE_DIR`, by default `~/.local/state/loopgate`. They stay local and are never committed.

## Design

[intent.md](intent.md) says what loopgate is for and what it will not do. [spec.md](spec.md) is the contract. The decisions are in [docs/adr](docs/adr).

## References

The design rests on public work; the tools are an application of it, not a copy.

- Anthropic, [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents): keep the human in the loop at checkpoints, stop on explicit conditions, and test agents in a sandbox before trusting them.
- Anthropic, [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents): one change per session, a commit at the end of each, and end-to-end verification before something counts as done. This is the loop loopgate enforces.
- Anthropic, [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps): a separate, deliberately skeptical evaluator beats an agent grading its own work. The pre-push reviewer plays that role.
- Claude Code, [Hooks reference](https://code.claude.com/docs/en/hooks): the `PreToolUse` hook and its exit-code semantics, which the push hook is built on.

## Licence

MIT. See [LICENSE](LICENSE).
