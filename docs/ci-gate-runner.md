# CI gate runner

Runs the repo's gates locally before a push. Design: [ADR-0001](adr/0001-ci-gate-runner.md).

```
node bin/ci-gate-runner.ts [dir]      # or: npm run ci-gate-runner -- [dir]
```

From the repo you are about to push (or pass its path). Commit first: the pass is recorded for the commit, and a dirty tree is refused. A slow gate run (minutes) belongs in the background.

- The gates are in the repo's `loopgate.json` (see the [spec](../spec.md) for the file). A repo without one has no gates; the runner says so.
- Gates run one at a time and stop at the first failure, which prints the last 60 lines of its output. Exit 0 on a full pass or no gates, 1 on a failed gate, 2 when it cannot run (dirty tree, not a repo, invalid config).
- A full pass writes `ci-gate-pass.json` in the state directory (`LOOPGATE_STATE_DIR`, default `~/.local/state/loopgate`). The push hook allows `git push` from that repo only while its `HEAD` matches.
- A fresh git worktree has no `node_modules` or virtualenv: if `environment` is set in the config, the runner stops before running anything and says what to install.
- A gate that runs longer than 20 minutes (or its `timeoutMs`) is stopped (`TIMED OUT`).
- A gate with `needsTestDb` runs only if the variable named by `testDatabaseEnv` (default `DATABASE_URL`) points at a `*_test` database on this machine. Any other name, or a remote host, is refused.
