import type { Exec } from '../gates/git.ts';

export interface Finding {
	id: string;
	source: 'check-summary' | 'check-annotation' | 'review' | 'inline' | 'issue';
	author?: string;
	path?: string;
	line?: number;
	body: string;
	/** Posted before the head commit, so a later push may or may not have answered it: check the code. */
	stale: boolean;
	/** The reviewer says it did not run, test or verify something: worth running ourselves. */
	unverifiedClaim: boolean;
	/** Sibling repos the finding mentions; their `origin/main` SHA is in `siblingShas`. */
	crossRepo: string[];
}

export interface Collected {
	repo: string;
	pr: number;
	headSha: string;
	check: string;
	findings: Finding[];
	siblingShas: Record<string, string | null>;
	warnings: string[];
}

export interface CollectDeps {
	exec: Exec;
	env: Record<string, string | undefined>;
	cwd: string;
	/** Other repos a finding may name (`siblingRepos` in `loopgate.json`); their SHAs are looked up. */
	siblingRepos: string[];
}

const PAGE = 100;
const MAX_PAGES = 10;

/**
 * The only way this tool talks to GitHub, as an allowlist: `gh api repos/...` with at most one
 * `--jq <expr>` (a GET). Every other flag, in any spelling (`-X`, `--method=POST`, `-fk=v`,
 * `--input=f`), and every other command is refused before gh runs, so a bug here cannot reply to,
 * resolve or edit anything.
 */
function isReadOnly(args: string[]): boolean {
	const [command, target, ...rest] = args;
	const jq = rest.length === 2 && rest[0] === '--jq';
	return (
		command === 'api' &&
		target !== undefined &&
		target.startsWith('repos/') &&
		(rest.length === 0 || jq)
	);
}

export function ghRead(deps: CollectDeps, args: string[]): string {
	if (!isReadOnly(args)) throw new Error(`Refused: gh ${args.join(' ')} is not a read-only call.`);
	const run = deps.exec('gh', args, deps.cwd, deps.env, 60_000);
	if (run.timedOut) throw new Error(`gh ${args[0]} did not answer in time.`);
	if (run.code !== 0) throw new Error(`gh ${args.join(' ')} failed: ${run.output.trim()}`);
	return run.stdout ?? run.output;
}

/** A list endpoint read page by page (oldest first), so a long PR does not lose its newest items. */
function ghPages<T>(deps: CollectDeps, path: string, what: string, warnings: string[]): T[] {
	const all: T[] = [];
	for (let page = 1; page <= MAX_PAGES; page += 1) {
		const items = ghJson<T[]>(deps, ['api', `${path}?per_page=${PAGE}&page=${page}`]);
		all.push(...items);
		if (items.length < PAGE) return all;
	}
	warnings.push(`${what}: stopped after ${MAX_PAGES * PAGE} items, so there may be more.`);
	return all;
}

function ghJson<T>(deps: CollectDeps, args: string[]): T {
	const text = ghRead(deps, args);
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new Error(`gh ${args.join(' ')} did not return JSON.`);
	}
}

const UNVERIFIED =
	/\b(?:did not|didn't|do not|don't|have not|haven't|could not|couldn't|cannot|can't|unable to|never|not)\s+(?:actually\s+|been\s+)?(?:run|ran|execute[d]?|test(?:ed)?|verif(?:y|ied)|check(?:ed)?|confirm(?:ed)?|reproduce[d]?)\b|\b(?:untested|unverified|not run)\b/i;

export function claimsUnverified(text: string): boolean {
	return UNVERIFIED.test(text);
}

export function siblingsMentioned(text: string, self: string, siblings: string[]): string[] {
	return siblings.filter(
		(name) =>
			name !== self &&
			new RegExp(`(?<![\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(text)
	);
}

interface Person {
	login: string;
	type: string;
}
interface Comment {
	id: number;
	user: Person | null;
	body: string | null;
	path?: string;
	line?: number | null;
	commit_id?: string | null;
	created_at?: string;
}

export function collect(
	deps: CollectDeps,
	options: { pr: number; repo: string; check: string; authors: string[] }
): Collected {
	const repo = options.repo;
	const [owner = '', name = ''] = repo.split('/');
	const warnings: string[] = [];

	const pull = ghJson<{ head: { sha: string } }>(deps, [
		'api',
		`repos/${repo}/pulls/${options.pr}`
	]);
	const headSha = pull.head.sha;
	const findings: Finding[] = [];
	const add = (
		finding: Omit<Finding, 'unverifiedClaim' | 'crossRepo' | 'stale'> & { stale?: boolean }
	) => {
		findings.push({
			stale: false,
			...finding,
			unverifiedClaim: claimsUnverified(finding.body),
			crossRepo: siblingsMentioned(finding.body, name, deps.siblingRepos)
		});
	};

	const runs = ghJson<{
		check_runs: {
			id: number;
			name: string;
			conclusion: string | null;
			output: { title: string | null; summary: string | null; text: string | null };
		}[];
	}>(deps, ['api', `repos/${repo}/commits/${headSha}/check-runs?per_page=${PAGE}`]);
	if (runs.check_runs.length >= PAGE) {
		warnings.push(`check runs: ${PAGE} items is the page limit, so there may be more.`);
	}
	// A reusable workflow's job is reported as "<caller job> / <called job>", so match the tail too.
	const tails = runs.check_runs.filter((run) => run.name.endsWith(` / ${options.check}`));
	const check = runs.check_runs.find((run) => run.name === options.check) ?? tails[0];
	if (check !== undefined && check.name !== options.check && tails.length > 1) {
		warnings.push(
			`${tails.length} check runs end in "/ ${options.check}" (${tails.map((r) => r.name).join(', ')}): not picking one.`
		);
	} else if (check === undefined) {
		warnings.push(`No check run named "${options.check}" at ${headSha.slice(0, 7)}.`);
	} else {
		const text = [check.output.title, check.output.summary, check.output.text]
			.filter((part): part is string => !!part)
			.join('\n\n');
		if (text !== '') add({ id: `check-${check.id}`, source: 'check-summary', body: text });
		const annotations = ghPages<{
			path: string;
			start_line: number;
			title: string | null;
			message: string;
		}>(deps, `repos/${repo}/check-runs/${check.id}/annotations`, 'annotations', warnings);
		annotations.forEach((a, index) =>
			add({
				id: `annotation-${check.id}-${index}`,
				source: 'check-annotation',
				path: a.path,
				line: a.start_line,
				body: [a.title, a.message].filter((part) => !!part).join('\n')
			})
		);
	}

	const mine = (user: Person | null): user is Person =>
		user !== null && (user.type === 'Bot' || options.authors.includes(user.login));
	// The head commit's date, to date issue comments (they carry no commit).
	const headDate = ghRead(deps, [
		'api',
		`repos/${repo}/commits/${headSha}`,
		'--jq',
		'.commit.committer.date'
	]).trim();
	const take = (source: 'review' | 'inline' | 'issue', comments: Comment[]) => {
		for (const c of comments) {
			const user = c.user;
			if (!mine(user) || !c.body) continue;
			// A push does not answer a finding, so earlier ones are kept and marked: the agent checks
			// the current code for them. Inline comments still on a live line follow the head commit.
			const stale =
				source === 'issue'
					? c.created_at !== undefined && c.created_at < headDate
					: c.commit_id !== headSha;
			add({
				id: `${source}-${c.id}`,
				source,
				author: user.login,
				stale,
				...(c.path !== undefined && { path: c.path }),
				...(typeof c.line === 'number' && { line: c.line }),
				body: c.body
			});
		}
	};
	take(
		'review',
		ghPages<Comment>(deps, `repos/${repo}/pulls/${options.pr}/reviews`, 'reviews', warnings)
	);
	take(
		'inline',
		ghPages<Comment>(
			deps,
			`repos/${repo}/pulls/${options.pr}/comments`,
			'inline comments',
			warnings
		)
	);
	take(
		'issue',
		ghPages<Comment>(deps, `repos/${repo}/issues/${options.pr}/comments`, 'PR comments', warnings)
	);
	const staleCount = findings.filter((f) => f.stale).length;
	if (staleCount > 0) {
		warnings.push(
			`${staleCount} finding(s) were posted before ${headSha.slice(0, 7)} and are marked stale: check the current code for each.`
		);
	}

	// A claim about another repo is checked against that repo's current origin/main, so name the SHA.
	const siblingShas: Record<string, string | null> = {};
	for (const sibling of new Set(findings.flatMap((f) => f.crossRepo))) {
		try {
			siblingShas[sibling] = ghRead(deps, [
				'api',
				`repos/${owner}/${sibling}/commits/main`,
				'--jq',
				'.sha'
			]).trim();
		} catch {
			siblingShas[sibling] = null;
			warnings.push(
				`Could not read origin/main of ${sibling}; do not state claims about it as fact.`
			);
		}
	}
	return { repo, pr: options.pr, headSha, check: options.check, findings, siblingShas, warnings };
}
