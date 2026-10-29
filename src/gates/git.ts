import { basename } from 'node:path';

export interface Exec {
	(
		command: string,
		args: string[],
		cwd: string,
		env?: Record<string, string | undefined>,
		timeoutMs?: number
	): {
		code: number;
		/** Standard output and standard error together, for showing a failure. */
		output: string;
		/** Standard output alone: what to parse (git prints warnings on stderr). */
		stdout?: string;
		/** The command did not finish in time (its `code` is then not meaningful). */
		timedOut?: boolean;
		/** The command could not be started (not installed, not executable). */
		unrunnable?: boolean;
	};
}

export interface RepoState {
	top: string;
	name: string;
	head: string;
	dirty: boolean;
}

/** What a command printed on stdout, for parsing; falls back to the combined output. */
export function stdoutOf(result: { output: string; stdout?: string }): string {
	return result.stdout ?? result.output;
}

/** git did not answer in time or could not be run: different from `dir` not being a repo. */
export class GitUnavailable extends Error {
	constructor(dir: string, unrunnable = false) {
		super(unrunnable ? `git could not be run in ${dir}.` : `git did not answer in time in ${dir}.`);
	}
}

/**
 * The repo containing `dir`, or undefined when `dir` is not in a git work tree (or has no commit
 * yet). Throws `GitUnavailable` when git times out, so the caller can fail closed.
 */
export function repoState(dir: string, exec: Exec): RepoState | undefined {
	const run = (args: string[]) => {
		const result = exec('git', args, dir);
		if (result.timedOut || result.unrunnable) throw new GitUnavailable(dir, !result.timedOut);
		return result;
	};
	const info = run(['rev-parse', '--show-toplevel', 'HEAD']);
	if (info.code !== 0) return undefined;
	const [top = '', head = ''] = stdoutOf(info).trim().split('\n');
	const status = run(['status', '--porcelain']);
	if (status.code !== 0) return undefined;
	const origin = run(['remote', 'get-url', 'origin']);
	// The name comes from the origin remote, so a worktree or a clone under another name still
	// finds its gates; a repo with no origin falls back to its directory name.
	const name = origin.code === 0 ? remoteName(stdoutOf(origin)) : basename(top);
	return { top, name, head, dirty: stdoutOf(status).trim() !== '' };
}

/** `git@github.com:example-org/example-api.git` or an https URL -> `example-api`. */
export function remoteName(url: string): string {
	return basename(
		url
			.trim()
			.replace(/\/+$/, '')
			.replace(/\.git$/, '')
			.replace(/:/g, '/')
	);
}
