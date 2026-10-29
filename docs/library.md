# Library

loopgate's tools run straight from TypeScript source (`node bin/<tool>.ts`). A package that depends on loopgate cannot do that: Node does not strip types from files under `node_modules`. So the process and git helpers other tools need are also built to `dist/` (JavaScript plus type declarations) and exported from the package root.

```ts
import { gatesBlock, repoState, spawnExec, stdoutOf, withBudget } from 'loopgate';
```

| Export | What it is |
|---|---|
| `spawnExec(defaultTimeoutMs?)`, `withBudget(...)`, `Exec` | Run a command to completion with a time limit, or share one time budget across several calls. A timeout is reported, not thrown. |
| `repoState(dir, exec)`, `stdoutOf`, `remoteName`, `GitUnavailable`, `RepoState` | The repo that contains `dir`: top, name (from `origin`, else the directory), `HEAD` and whether the tree is dirty. A git that times out or cannot run throws `GitUnavailable`, so a caller can fail closed. |
| `gatesBlock(dir, deps)`, `StatusDeps` | Why a `git push` from `dir` must wait, or `undefined` when it may go: the repo has no `loopgate.json`, or the gates passed for `HEAD` and the tree is clean. An invalid config blocks. |

Nothing else is public. `src/index.ts` is the whole surface and `tests/index.test.ts` fails when it changes.

## Depending on it

Pin a tag, so a change in loopgate never reaches you unannounced:

```json
{ "dependencies": { "loopgate": "github:kangaliaisaac/loopgate#v0.1.0" } }
```

The `prepare` script builds `dist/` when npm installs from git. The exports follow semantic versioning from 1.0; before that, a minor version may change them.
