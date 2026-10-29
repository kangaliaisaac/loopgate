import { configOrMessage } from './config.ts';
import { GitUnavailable, repoState, type Exec } from './git.ts';
import { parseRecord, recordPath, type RecordIo } from './record.ts';

export interface StatusDeps extends RecordIo {
	exec: Exec;
	stateDir: string;
	/** Absolute path of `bin/ci-gate-runner.ts`, named in the message. */
	runnerPath: string;
}

/**
 * Why a `git push` from `dir` must wait, or undefined when it may go: not a repo, a repo with no
 * `loopgate.json`, or the current commit's gates passed and nothing is uncommitted.
 */
export function gatesBlock(dir: string, deps: StatusDeps): string | undefined {
	let repo;
	try {
		repo = repoState(dir, deps.exec);
	} catch (error) {
		if (!(error instanceof GitUnavailable)) throw error;
		// Fail closed: a slow git must not read as "not a repo" and let an untested push through.
		return `${error.message} The CI-gate status of this push could not be checked; retry the push.`;
	}
	if (repo === undefined) return undefined;
	const config = configOrMessage(repo.top, deps.readFile);
	// Fail closed: a broken config must not read as "no gates".
	if (typeof config === 'string') return config;
	if (config === undefined) return undefined;
	const how = `Run \`node "${deps.runnerPath}"\` from "${repo.top}" (it takes minutes: run it in the background and wait), then push. In a fresh git worktree, install the dependencies there first; the runner says what is missing.`;
	if (repo.dirty) {
		return `${repo.name} has uncommitted changes, so the gates would not test what is pushed. Commit first. ${how}`;
	}
	const passed = parseRecord(deps.readFile(recordPath(deps.stateDir)))[repo.top];
	if (passed?.head === repo.head) return undefined;
	return `The CI gates have not passed for ${repo.name} at ${repo.head.slice(0, 7)}. ${how}`;
}
