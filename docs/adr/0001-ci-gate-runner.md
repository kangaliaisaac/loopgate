# ADR-0001: A push waits for the repo's CI gates to pass locally

Status: accepted

## Context

A push that fails a CI gate costs a CI round and, because the remote review runs on every push, a review round as well. The gates are known and cheap to run first, but as advice they get skipped. A `PreToolUse` hook cannot run them itself: a hook has seconds, and a full gate run takes minutes.

## Decision

Two parts, joined by a record.

- **`bin/ci-gate-runner.ts [dir]`** runs the repo's gates one at a time and stops at the first failure, printing the last 60 lines of its output. The gates are the commands in the repo's own `loopgate.json`, not a table in loopgate, so loopgate gates any language and a repo's CI and its local gates stay in one reviewable file in that repo.
- **The runner refuses a dirty tree** and, on a full pass, records the work tree's path and `HEAD` in the gate pass record in the state directory. A pass belongs to a commit, so it is what is pushed that has been tested.
- **The push hook reads the record.** `hooks/pre-push-gate.sh` blocks `git push` from Claude Code unless the record holds the current `HEAD` and the tree is clean. It starts nothing; it only reads, so it stays well inside a hook's time limit. Library users get the same check as `gatesBlock`.
- **A repo with no `loopgate.json` has no gates.** The runner says so and exits 0. An invalid file is an error that names the key; it never falls back to a default, and `gatesBlock` blocks rather than allows.
- **A repo is identified by its `origin` remote name,** falling back to the directory name, so a git worktree or a clone under another name is the same repo. The pass is keyed by the work tree's own path.
- **A slow or missing git blocks.** A git call that times out or cannot be run raises `GitUnavailable`; only a plain "not a git repo" answer allows. The runner exits 2 and runs nothing.
- **A fresh worktree is told what to install.** A worktree shares history but not `node_modules` or a virtualenv, so when the config names an `environment` path that is missing, the runner says what to run before it runs anything.
- **A hung gate is stopped** after 20 minutes (or the gate's `timeoutMs`), with its last output.
- **Database gates need a test database.** A gate marked `needsTestDb` is refused, before running, unless the variable named by `testDatabaseEnv` (default `DATABASE_URL`) names a `*_test` database on this machine. URLs that carry `host`, `hostaddr`, `dbname` or `service` parameters are refused, since those replace the host and database the path names.

## Consequences

- This is a gate, not a trigger: the first push attempt is blocked with the command to run, the second goes through. One extra round trip buys a hook that never times out.
- A pass is per commit; any new commit, including an amend, needs the gates again. A push of another branch is judged by the checked-out `HEAD`.
- The hook splits a command into segments (at `;`, `&`, `|`, parentheses and backticks, but not inside quotes, backticks or `$( )`, where they are part of a word) and checks every segment that runs `git`, its global options, then `push`; a `cd` moves the directory for what follows it. A push it cannot place is refused, so such a push is run on its own: a `cd` in a command that also has a group, a substitution, backticks, `sh -c` or `eval`; `pushd`, `GIT_DIR`, `--git-dir`, `--work-tree`, `--chdir`; or several `-C`. A commit message that mentions pushing is not a push, but a command that mentions one inside a `git` argument list can still be read as one. A `cd` that is conditional (`[ -d x ] && cd y`, inside an `if`, before `|| true`) is treated as if it ran, so the push may be judged by another repo than the one it runs in; the hook does not model control flow.
- The hook reads commands, not intent, and covers only pushes Claude makes. A push from a script or from the owner's own terminal skips it, so CI remains the backstop.
- The pass record is rewritten through a temporary file and a rename. Two runners finishing together can lose one entry, which costs one extra block.
