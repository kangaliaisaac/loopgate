import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Exec } from '../src/gates/git.ts';
import { main, type CliDeps } from '../src/triage/cli.ts';
import {
	claimsUnverified,
	collect,
	ghRead,
	siblingsMentioned,
	type CollectDeps
} from '../src/triage/collect.ts';

type Routes = Record<string, unknown>;
interface Fake {
	exec: Exec;
	calls: string[][];
}

/** A fake gh: each route is matched on the API path (without the query); a string is raw stdout. */
function fakeGh(routes: Routes, failing: string[] = [], timeout: string[] = []): Fake {
	const calls: string[][] = [];
	const exec: Exec = (command, args) => {
		calls.push([command, ...args]);
		const key = args[0] === 'api' ? (args[1] ?? '').split('?')[0]! : args.slice(0, 2).join(' ');
		if (timeout.includes(key)) return { code: 1, output: '', timedOut: true };
		if (failing.includes(key)) return { code: 1, output: 'HTTP 404', stdout: '' };
		const raw = routes[key];
		const page = Number(/[?&]page=(\d+)/.exec(args[1] ?? '')?.[1] ?? '1');
		const value = typeof raw === 'function' ? (raw as (page: number) => unknown)(page) : raw;
		const text = typeof value === 'string' ? value : JSON.stringify(value);
		return { code: 0, output: text, stdout: text };
	};
	return { exec, calls };
}

const SIBLINGS = ['example-api', 'example-worker', 'example-web', 'example-docs'];
const deps = (fake: Fake): CollectDeps => ({
	exec: fake.exec,
	env: {},
	cwd: '/w',
	siblingRepos: SIBLINGS
});
const base = 'repos/example-org/example-api';
const REPO = 'example-org/example-api';
const HEAD = 'abcdef1234567';
const STALE_WARNING =
	'2 finding(s) were posted before abcdef1 and are marked stale: check the current code for each.';

const routes = (extra: Routes = {}): Routes => ({
	[`${base}/commits/abcdef1234567`]: '2026-10-20T10:00:00Z\n',
	[`${base}/issues/7/comments`]: [
		{
			id: 30,
			user: { login: 'bot[bot]', type: 'Bot' },
			body: 'Round summary',
			created_at: '2026-10-20T12:00:00Z'
		},
		{
			id: 31,
			user: { login: 'bot[bot]', type: 'Bot' },
			body: 'Old summary',
			created_at: '2026-10-19T12:00:00Z'
		},
		{
			id: 32,
			user: { login: 'human', type: 'User' },
			body: 'x',
			created_at: '2026-10-20T12:00:00Z'
		}
	],
	[`${base}/pulls/7`]: { head: { sha: 'abcdef1234567' } },
	[`${base}/commits/abcdef1234567/check-runs`]: {
		check_runs: [
			{ id: 1, name: 'fmt', output: { title: null, summary: null, text: null } },
			{
				id: 2,
				name: 'review',
				output: { title: 'Review', summary: 'I did not run the tests.', text: null }
			}
		]
	},
	[`${base}/check-runs/2/annotations`]: [
		{
			path: 'src/a.rs',
			start_line: 12,
			title: 'Bug',
			message: 'Mismatch with example-worker schema, example-api is fine, see example-docs'
		},
		{ path: 'src/b.rs', start_line: 3, title: null, message: 'Off by one' }
	],
	[`${base}/pulls/7/reviews`]: [
		{ id: 10, commit_id: HEAD, user: { login: 'bot[bot]', type: 'Bot' }, body: 'Looks risky' },
		{ id: 11, commit_id: HEAD, user: { login: 'human', type: 'User' }, body: 'ignored' },
		{ id: 12, commit_id: HEAD, user: { login: 'bot[bot]', type: 'Bot' }, body: '' },
		{ id: 13, commit_id: HEAD, user: null, body: 'ghost' },
		{
			id: 14,
			commit_id: 'oldsha0000000',
			user: { login: 'bot[bot]', type: 'Bot' },
			body: 'Old round'
		}
	],
	[`${base}/pulls/7/comments`]: [
		{
			id: 20,
			commit_id: HEAD,
			user: { login: 'bot[bot]', type: 'Bot' },
			body: 'Nit',
			path: 'x.rs',
			line: 4
		},
		{
			id: 21,
			commit_id: HEAD,
			user: { login: 'human', type: 'User' },
			body: 'Mine',
			path: 'y.rs',
			line: null
		},
		{ id: 22, commit_id: HEAD, user: { login: 'bot[bot]', type: 'Bot' }, body: 'General' }
	],
	'repos/example-org/example-worker/commits/main': 'w0rkersha\n',
	'repos/example-org/example-docs/commits/main': 'd0cssha\n',
	...extra
});

describe('ghRead', () => {
	const ok = deps(fakeGh({ 'repos/a/b/x': 'x' }));
	it('allows api reads of repos, with or without one --jq', () => {
		expect(ghRead(ok, ['api', 'repos/a/b/x'])).toBe('x');
		expect(ghRead(ok, ['api', 'repos/a/b/x', '--jq', '.sha'])).toBe('x');
	});

	it.each([
		[['api', 'repos/a/b/pulls/1/comments', '-X', 'POST']],
		[['api', 'repos/a/b/pulls/1/comments', '--method', 'POST']],
		[['api', 'repos/a/b/issues/1/comments', '-f', 'body=hi']],
		[['api', 'repos/a/b/issues/1/comments', '-F', 'body=hi']],
		[['api', 'repos/a/b/issues/1/comments', '-fbody=hi']],
		[['api', 'graphql', '--raw-field', 'query=x']],
		[['api', 'x', '--input', 'f.json']],
		[['api', 'repos/a/b/issues/1/comments', '--method=POST']],
		[['api', 'repos/a/b/issues/1/comments', '--field=body=x']],
		[['api', 'repos/a/b/issues/1/comments', '--raw-field=body=x']],
		[['api', 'repos/a/b/x', '--input=f.json']],
		[['api', 'repos/a/b/x', '-H', 'X-HTTP-Method-Override: DELETE']],
		[['api', 'graphql']],
		[['api']],
		[['api', 'repos/a/b/x', '--jq']],
		[['repo', 'view']],
		[['repo', 'view', '--json', 'nameWithOwner', '--jq', '.x']],
		[['pr', 'merge', '1']],
		[['pr', 'comment', '1']],
		[['repo', 'delete', 'a/b']],
		[[]]
	])('refuses %j before gh runs', (args) => {
		const fake = fakeGh({});
		expect(() => ghRead(deps(fake), args)).toThrow(/Refused/);
		expect(fake.calls).toEqual([]);
	});

	it('reports a failure and a timeout', () => {
		const args = ['api', 'repos/a/b/x'];
		expect(() => ghRead(deps(fakeGh({}, ['repos/a/b/x'])), args)).toThrow(/HTTP 404/);
		expect(() => ghRead(deps(fakeGh({}, [], ['repos/a/b/x'])), args)).toThrow(/did not answer/);
	});

	it('falls back to the combined output when stdout is absent', () => {
		const exec: Exec = () => ({ code: 0, output: 'all' });
		expect(ghRead({ exec, env: {}, cwd: '/', siblingRepos: [] }, ['api', 'repos/a/b/x'])).toBe(
			'all'
		);
	});
});

describe('claim detection', () => {
	it.each([
		'I did not run the tests',
		"I haven't verified this",
		'This was never tested',
		'not run locally',
		'untested change',
		'could not reproduce it',
		'Unable to confirm',
		'has not been executed'
	])('flags "%s"', (text) => expect(claimsUnverified(text)).toBe(true));

	it.each(['The test runs and passes', 'Off by one in the loop', 'run the tests'])(
		'leaves "%s"',
		(text) => expect(claimsUnverified(text)).toBe(false)
	);

	it('lists sibling repos other than the current one', () => {
		expect(
			siblingsMentioned('example-api and example-worker, example-workers', 'example-api', SIBLINGS)
		).toEqual(['example-worker']);
		expect(siblingsMentioned('nothing', 'example-api', SIBLINGS)).toEqual([]);
		expect(siblingsMentioned('a.b and axb', 'x', ['a.b'])).toEqual(['a.b']);
		expect(siblingsMentioned('axb', 'x', ['a.b'])).toEqual([]);
	});
});

describe('collect', () => {
	const opts = {
		pr: 7,
		repo: 'example-org/example-api',
		check: 'review',
		authors: [] as string[]
	};

	it('gathers the check, annotations and bot comments, and cites sibling SHAs', () => {
		const fake = fakeGh(routes());
		const got = collect(deps(fake), opts);
		expect(got.repo).toBe('example-org/example-api');
		expect(got.headSha).toBe('abcdef1234567');
		expect(got.warnings).toEqual([STALE_WARNING]);
		expect(got.siblingShas).toEqual({ 'example-worker': 'w0rkersha', 'example-docs': 'd0cssha' });
		expect(got.findings.map((f) => f.id)).toEqual([
			'check-2',
			'annotation-2-0',
			'annotation-2-1',
			'review-10',
			'review-14',
			'inline-20',
			'inline-22',
			'issue-30',
			'issue-31'
		]);
		expect(got.findings.filter((f) => f.stale).map((f) => f.id)).toEqual(['review-14', 'issue-31']);
		expect(got.findings[0]).toMatchObject({
			source: 'check-summary',
			body: 'Review\n\nI did not run the tests.',
			unverifiedClaim: true,
			crossRepo: []
		});
		expect(got.findings[1]).toMatchObject({
			path: 'src/a.rs',
			line: 12,
			body: 'Bug\nMismatch with example-worker schema, example-api is fine, see example-docs',
			unverifiedClaim: false,
			crossRepo: ['example-worker', 'example-docs']
		});
		expect(got.findings[2]).toMatchObject({ body: 'Off by one' });
		expect(got.findings[5]).toMatchObject({ author: 'bot[bot]', path: 'x.rs', line: 4 });
		expect(got.findings[6]).not.toHaveProperty('path');
		expect(got.findings[6]).not.toHaveProperty('line');
		expect(got.findings[7]).toMatchObject({ source: 'issue', body: 'Round summary', stale: false });
		// every call was a read
		expect(fake.calls.every((c) => c[1] === 'api' || c[1] === 'repo')).toBe(true);
		expect(fake.calls.flat()).not.toContain('-X');
	});

	it('uses the given check name and extra authors', () => {
		const fake = fakeGh(routes());
		const got = collect(deps(fake), { ...opts, authors: ['human'] });
		expect(fake.calls.some((c) => c[1] === 'repo')).toBe(false);
		expect(got.findings.map((f) => f.id)).toContain('review-11');
		expect(got.findings.map((f) => f.id)).toContain('inline-21');
		expect(got.findings.find((f) => f.id === 'inline-21')).not.toHaveProperty('line');
	});

	it('warns when the check run is missing, and skips an empty check output', () => {
		const missing = collect(deps(fakeGh(routes())), { ...opts, check: 'nope' });
		expect(missing.warnings).toEqual(['No check run named "nope" at abcdef1.', STALE_WARNING]);
		const empty = collect(deps(fakeGh(routes({ [`${base}/check-runs/1/annotations`]: [] }))), {
			...opts,
			check: 'fmt'
		});
		expect(empty.findings.some((f) => f.source === 'check-summary')).toBe(false);
	});

	const bot = { login: 'b', type: 'Bot' };
	const item = (id: number) => ({ id, commit_id: HEAD, user: bot, body: `finding ${id}` });

	it('reads every page of reviews, inline and PR comments, oldest first', () => {
		const pages = (n: number) => (page: number) =>
			page === 1 ? Array.from({ length: 100 }, (_, i) => item(i)) : [item(1000 + n)];
		const fake = fakeGh(
			routes({
				[`${base}/pulls/7/reviews`]: pages(1),
				[`${base}/pulls/7/comments`]: pages(2),
				[`${base}/issues/7/comments`]: [],
				[`${base}/check-runs/2/annotations`]: pages(3)
			})
		);
		const got = collect(deps(fake), opts);
		expect(got.findings.filter((f) => f.source === 'review')).toHaveLength(101);
		expect(got.findings.filter((f) => f.source === 'inline')).toHaveLength(101);
		expect(got.findings.some((f) => f.id === 'review-1001')).toBe(true);
		expect(got.warnings).toEqual([]);
	});

	it('stops at the page cap with a warning, and warns when a sibling SHA cannot be read', () => {
		const always = () => Array.from({ length: 100 }, (_, i) => item(i));
		const fake = fakeGh(
			routes({
				[`${base}/pulls/7/reviews`]: always,
				[`${base}/pulls/7/comments`]: [],
				[`${base}/issues/7/comments`]: [],
				[`${base}/check-runs/2/annotations`]: Array.from({ length: 3 }, () => ({
					path: 'p',
					start_line: 1,
					title: 't',
					message: 'see example-web and example-worker-foo'
				}))
			}),
			['repos/example-org/example-web/commits/main']
		);
		const got = collect(deps(fake), opts);
		expect(got.findings.filter((f) => f.source === 'review')).toHaveLength(1000);
		expect(got.siblingShas).toEqual({ 'example-web': null });
		expect(got.warnings).toEqual([
			'reviews: stopped after 1000 items, so there may be more.',
			'Could not read origin/main of example-web; do not state claims about it as fact.'
		]);
	});

	it('warns when there are 100 check runs', () => {
		const runs = Array.from({ length: 100 }, (_, i) => ({
			id: i + 100,
			name: `c${i}`,
			output: { title: null, summary: null, text: null }
		}));
		const got = collect(
			deps(fakeGh(routes({ [`${base}/commits/abcdef1234567/check-runs`]: { check_runs: runs } }))),
			opts
		);
		expect(got.warnings[0]).toMatch(/^check runs: 100 items/);
	});

	it('fails on output that is not JSON', () => {
		expect(() => collect(deps(fakeGh(routes({ [`${base}/pulls/7`]: 'oops' }))), opts)).toThrow(
			/did not return JSON/
		);
	});
});

describe('main', () => {
	const make = (fake: Fake) => {
		const written: Record<string, string> = {};
		const d: CliDeps = {
			...deps(fake),
			stateDir: '/state',
			writeFile: (path, text) => {
				written[path] = text;
			}
		};
		return { d, written };
	};

	it('writes the findings and prints a summary', () => {
		const { d, written } = make(fakeGh(routes()));
		const result = main(
			['fetch', '--pr', '7', '--repo', REPO, '--author', 'human,', '--check', 'review'],
			d
		);
		expect(result.exitCode).toBe(0);
		const path = '/state/review-triage/example-org-example-api-pr7.json';
		expect(Object.keys(written)).toEqual([path]);
		expect(JSON.parse(written[path]!).findings).toHaveLength(12);
		expect(JSON.parse(result.stdout)).toMatchObject({
			path,
			pr: 7,
			headSha: 'abcdef1234567',
			findings: 12,
			stale: 2,
			unverifiedClaims: 1,
			siblingShas: { 'example-worker': 'w0rkersha' }
		});
	});

	it('defaults to the review check and no extra authors', () => {
		const result = main(['fetch', '--pr', '7', '--repo', REPO], make(fakeGh(routes())).d);
		expect(JSON.parse(result.stdout).findings).toBe(9);
	});

	it('requires --repo and never asks gh which repo it is', () => {
		const fake = fakeGh(routes());
		const result = main(['fetch', '--pr', '7'], make(fake).d);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain('--repo OWNER/NAME is required');
		expect(fake.calls).toEqual([]);
	});

	it('exits 1 when gh fails, and 2 on bad input', () => {
		const failed = main(
			['fetch', '--pr', '7', '--repo', REPO],
			make(fakeGh(routes(), [`${base}/pulls/7`])).d
		);
		expect(failed).toMatchObject({ exitCode: 1, stdout: '' });
		expect(failed.stderr).toContain('HTTP 404');
		expect(failed.stderr).not.toContain('Usage');
		const d = make(fakeGh({})).d;
		for (const argv of [
			[],
			['nope'],
			['fetch'],
			['fetch', '--pr', '0'],
			['fetch', '--pr', 'x'],
			['fetch', '--pr', '1', '--repo', 'bad'],
			['fetch', '--bogus']
		]) {
			const r = main(argv, d);
			expect(r.exitCode).toBe(2);
			expect(r.stderr).toContain('Usage');
		}
		expect(main([], d).stderr).toContain('No command given.');
		expect(main(['nope'], d).stderr).toContain('Unknown command: nope');
	});
});

describe('agent and skill definitions', () => {
	const frontmatter = (path: string): Record<string, string> => {
		const match = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(path, 'utf8'));
		return Object.fromEntries(
			(match?.[1] ?? '')
				.split('\n')
				.map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)])
		);
	};

	it('defines a read-only Sonnet triager with the three groups and the two claim rules', () => {
		const meta = frontmatter('agents/review-triage.md');
		expect(meta['name']).toBe('review-triage');
		expect(meta['model']).toBe('sonnet');
		expect(meta['tools']).toBe('Read, Grep, Glob');
		const body = readFileSync('agents/review-triage.md', 'utf8');
		expect(body).toMatch(/Real defect/);
		expect(body).toMatch(/Noise/);
		expect(body).toMatch(/Owner decision/);
		expect(body).toMatch(/worth running/);
		expect(body).toMatch(/siblingShas/);
		expect(body).toMatch(/TRIAGE: <d> defects/);
		expect(body).toMatch(
			/never edit, commit, push, run commands, reply to a comment, resolve a thread or merge/i
		);
	});

	it('has a skill that names the command and the agent, and never replies or merges', () => {
		const meta = frontmatter('skills/review-triage/SKILL.md');
		expect(meta['name']).toBe('review-triage');
		const body = readFileSync('skills/review-triage/SKILL.md', 'utf8');
		expect(body).toContain('bin/review-triage.ts fetch');
		expect(body).toContain('`review-triage` agent');
		expect(body).toMatch(/Do not reply to or resolve/);
	});
});
