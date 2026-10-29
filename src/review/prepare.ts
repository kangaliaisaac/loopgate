import { join } from 'node:path';
import { configOrMessage } from '../gates/config.ts';
import { GitUnavailable, repoState, stdoutOf, type Exec } from '../gates/git.ts';
import { classify, parseNumstat, type ChangedFile, type ReviewModel } from './classify.ts';

export interface PrepareDeps {
	exec: Exec;
	/** Environment for the git calls (the entry point turns off credential prompts). */
	env: Record<string, string | undefined>;
	/** Where tool state lives; the diff is written under `pre-push-review/`. */
	stateDir: string;
	exists: (path: string) => boolean;
	readFile: (path: string) => string | undefined;
	writeFile: (path: string, text: string) => void;
}

export interface Prepared {
	repo: string;
	top: string;
	branch: string;
	head: string;
	base: string;
	commits: string[];
	files: ChangedFile[];
	lines: number;
	model: ReviewModel;
	/** Why Opus was chosen. */
	reasons: string[];
	large: boolean;
	/** Unified diff of everything the push would add to `origin/main`. */
	diffPath: string;
	/** Rule files the reviewer should read for the repo's conventions. */
	context: string[];
	warnings: string[];
}

export type PrepareResult = { ok: true; prepared: Prepared } | { ok: false; message: string };

const fail = (message: string): PrepareResult => ({ ok: false, message });

/** Gather what a reviewer needs about the commits a push would publish, and pick the model. */
export function prepareReview(dir: string, deps: PrepareDeps): PrepareResult {
	try {
		return prepareIn(dir, deps);
	} catch (error) {
		if (!(error instanceof GitUnavailable)) throw error;
		return fail(`${error.message} Nothing was prepared; try again.`);
	}
}

function prepareIn(dir: string, deps: PrepareDeps): PrepareResult {
	const repo = repoState(dir, deps.exec);
	if (repo === undefined) return fail(`${dir} is not a git repo with a commit.`);
	// Every call after the first answers with a timeout or a result: a timeout is never read as "no".
	const git = (...args: string[]) => {
		const result = deps.exec('git', args, repo.top, deps.env);
		if (result.timedOut) throw new GitUnavailable(repo.top);
		return result;
	};
	const warnings: string[] = [];
	// A stalled or failed fetch only means origin/main may be stale, so it warns instead of stopping.
	const fetched = deps.exec('git', ['fetch', '-q'], repo.top, deps.env);
	if (fetched.code !== 0 || fetched.timedOut) {
		warnings.push(
			'git fetch failed or timed out: origin/main may be stale, so the diff may include merged work.'
		);
	}
	const remote = git('rev-parse', '--verify', '--quiet', 'origin/main');
	let base: string;
	if (remote.code === 0) {
		const merge = git('merge-base', 'origin/main', 'HEAD');
		if (merge.code !== 0)
			return fail('No merge base with origin/main; cannot tell what a push would add.');
		base = stdoutOf(merge).trim();
		if (base === repo.head) {
			return fail('Nothing to review: HEAD has no commits beyond origin/main.');
		}
	} else {
		// A new remote has no origin/main: the first push sends everything, so review everything.
		base = stdoutOf(git('hash-object', '-t', 'tree', '/dev/null')).trim();
		warnings.push('origin/main does not exist, so this review covers the whole tree.');
	}
	// No rename detection: a file moved out of a sensitive path must still show up there.
	const stat = git('diff', '--numstat', '--no-renames', base, 'HEAD');
	const diff = git('diff', '--no-color', '--no-renames', '-U5', base, 'HEAD');
	if (stat.code !== 0 || diff.code !== 0) return fail('git diff failed; nothing was prepared.');
	const files = parseNumstat(stdoutOf(stat));
	const config = configOrMessage(repo.top, deps.readFile);
	if (typeof config === 'string') return fail(config);
	const choice = classify(files, config?.sensitivePaths);
	if (repo.dirty) {
		warnings.push(
			'The working tree has uncommitted changes; they are not in this diff and not reviewed.'
		);
	}
	if (choice.large) {
		warnings.push(
			`${choice.lines} changed lines is a large review: it costs more and tends to miss things. ` +
				'Split the branch, or confirm before running it.'
		);
	}
	const branch = stdoutOf(git('rev-parse', '--abbrev-ref', 'HEAD')).trim();
	const diffPath = join(
		deps.stateDir,
		'pre-push-review',
		`${repo.name}-${repo.head.slice(0, 7)}.diff`
	);
	deps.writeFile(diffPath, stdoutOf(diff));
	const commits = stdoutOf(
		git('log', '--format=%h %s', remote.code === 0 ? `${base}..HEAD` : 'HEAD')
	)
		.split('\n')
		.filter((line) => line !== '');
	const context = ['CLAUDE.md', 'intent.md', 'spec.md', 'plan.md']
		.map((name) => join(repo.top, name))
		.filter(deps.exists);
	return {
		ok: true,
		prepared: {
			repo: repo.name,
			top: repo.top,
			branch,
			head: repo.head,
			base,
			commits,
			files,
			lines: choice.lines,
			model: choice.model,
			reasons: choice.reasons,
			large: choice.large,
			diffPath,
			context,
			warnings
		}
	};
}
