// The library surface other packages may import. Everything else is internal and may change.
export { spawnExec, withBudget } from './gates/exec.ts';
export { GitUnavailable, remoteName, repoState, stdoutOf } from './gates/git.ts';
export type { Exec, RepoState } from './gates/git.ts';
export { gatesBlock } from './gates/status.ts';
export type { StatusDeps } from './gates/status.ts';
