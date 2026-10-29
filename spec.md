# `loopgate`: spec

Status: accepted.

## Shape

TypeScript on Node 24+, run directly (`node bin/<tool>.ts`) with no build step. Functional core with thin I/O edges: each tool is a pure module in `src/` plus a small entry in `bin/` that passes in the process, clock, filesystem and `git`.

## The pieces

Three tools, two agents with their skills, one push hook, one reusable workflow and one small library. The tools are below; the others have their own sections.

### The three tools

| Tool              | Command                                                    | Reads                                      | Writes                                                             |
| ----------------- | ---------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| `ci-gate-runner`  | `node bin/ci-gate-runner.ts [dir]`                         | `loopgate.json` in the repo                | a pass record per work tree in the state directory                 |
| `pre-push-review` | `node bin/pre-push-review.ts prepare [dir]` / `log ...`    | the git diff against `origin/main`         | the diff file and a numbers-only review log in the state directory |
| `review-triage`   | `node bin/review-triage.ts fetch --pr N --repo owner/name` | the PR's comments through `gh` (read-only) | a findings JSON in the state directory                             |

State directory: `LOOPGATE_STATE_DIR`; when unset, `~/.local/state/loopgate`. The tools never assume a workspace layout, so a project that wants its state next to its work sets the variable (for example in its Claude Code settings `env`). It holds the gate pass record, the review log, the review diffs and the findings files: local, never committed.

## Config contract: `loopgate.json`

One file at the root of each repo that is gated, and only there: loopgate has its own (it gates itself), and every repo that adopts loopgate adds its own. It is read from the top level of the work tree being gated; there is no search upward, no global default and no shared copy, so a repo with no file has no gates and the runner says so. The file is configuration for that repo's commands, so it is committed in that repo.

```json
{
	"gates": [
		{
			"name": "ruff check",
			"command": "./.venv/bin/python",
			"args": ["-m", "ruff", "check", "."]
		},
		{
			"name": "pytest",
			"command": "./.venv/bin/python",
			"args": ["-m", "pytest", "-q"],
			"needsTestDb": true,
			"timeoutMs": 600000
		}
	],
	"environment": {
		"path": ".venv/bin/python",
		"fix": "run `uv sync`"
	},
	"testDatabaseEnv": "DATABASE_URL",
	"siblingRepos": [],
	"sensitivePaths": [
		{
			"pattern": "^migrations/",
			"label": "a database migration"
		}
	]
}
```

- `gates`: required, in run order. Each runs from the repo top, stops the run on failure, and is killed after `timeoutMs` (default 20 minutes).
- `environment`: optional. A path that must exist in the work tree before any gate runs; `fix` is shown when it does not (a fresh worktree).
- `testDatabaseEnv`: optional, default `DATABASE_URL`. A gate with `needsTestDb` is refused unless that variable names a local database ending in `_test`.
- `siblingRepos`: optional, default empty. Repo names `review-triage` should resolve to an `origin/main` SHA when a finding mentions them.
- `sensitivePaths`: optional, added to the built-in list (decision records, `CLAUDE.md`, workflows, agent, skill and hook definitions) that sends a diff to the stronger model.

An invalid file is an error that names the key, never a silent default.

## Push hook

`hooks/pre-push-gate.sh`, a Claude Code `PreToolUse` hook on `Bash`. It exits 2, with a message that tells Claude what to run, unless the state directory holds  
(a) a gate pass for this work tree at `HEAD` and  
(b) a review record for this repo at `HEAD` with zero `high` findings.

A new commit makes both stale. It reads only the records; it starts nothing. (a) is checked only in a repo that has a `loopgate.json`, and an uncommitted change also blocks, because the pass tested other code. It covers pushes Claude makes, not pushes from the owner's own terminal.

## Agents and skills

| Agent               | Skill             | What it does                                                                                                                             |
| ------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `pre-push-reviewer` | `pre-push-review` | Reads the diff `pre-push-review prepare` wrote and reports defects CI cannot catch. Read-only; `high` blocks the push.                   |
| `review-triage`     | `review-triage`   | Sorts the findings of the remote review into real defects, noise and owner decisions. Read-only; never replies to or resolves a comment. |

## Library

The process and git helpers other tools need, compiled to `dist/` with type declarations: `exec` (`spawnExec`, `withBudget`), `git` (`repoState`, `stdoutOf`, `remoteName`, `GitUnavailable`) and `status` (`gatesBlock`). Nothing else is public. Node will not strip types from files under `node_modules`, so a package that imports loopgate gets the compiled output; inside this repo the tools still run straight from the `.ts` source. Documented in `docs/library.md`.

## Remote review

`.github/workflows/claude-review.yml`, a reusable workflow. Runs on non-draft pull requests from the same repository, with read-only tools and permission to comment. It never edits, approves or merges. Each adopting repo supplies the `CLAUDE_CODE_OAUTH_TOKEN` secret.

## Gates for `loopgate` itself

prettier (`printWidth` 100), `tsc --noEmit` strict, a build of the library, vitest at 100% coverage (including a test that runs the push hook against temporary repos), `npm audit --audit-level=high`, shellcheck on `*.sh`, gitleaks.

## Not in this repo

Anything specific to one codebase's layout, database or release process. Those belong in the adopting repo's `loopgate.json` and `CLAUDE.md`.
