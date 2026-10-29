import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Exec } from '../src/gates/git.ts';
import {
	LARGE_DIFF_LINES,
	SMALL_DIFF_LINES,
	classify,
	parseNumstat,
	type ChangedFile
} from '../src/review/classify.ts';
import { main, type CliDeps } from '../src/review/cli.ts';
import { logLine, logPath } from '../src/review/log.ts';
import { prepareReview, type PrepareDeps } from '../src/review/prepare.ts';

const file = (path: string, added = 10, deleted = 0): ChangedFile => ({ path, added, deleted });

describe('classify', () => {
	it('sends a small diff with no sensitive path to Sonnet', () => {
		expect(classify([file('src/a.ts', 50, 20), file('tests/a.test.ts', 100, 0)])).toEqual({
			model: 'sonnet',
			lines: 170,
			reasons: [],
			large: false
		});
	});

	it('uses Opus from the size threshold, and flags a large diff', () => {
		const exactly = classify([file('src/a.ts', SMALL_DIFF_LINES, 0)]);
		expect(exactly.model).toBe('opus');
		expect(exactly.reasons).toEqual([
			`${SMALL_DIFF_LINES} changed lines (Sonnet only below ${SMALL_DIFF_LINES})`
		]);
		expect(classify([file('src/a.ts', SMALL_DIFF_LINES - 1, 0)]).model).toBe('sonnet');
		expect(classify([file('src/a.ts', LARGE_DIFF_LINES - 1, 0)]).large).toBe(false);
		expect(classify([file('src/a.ts', LARGE_DIFF_LINES, 0)]).large).toBe(true);
	});

	it.each([
		['docs/adr/0007-x.md', 'a decision record'],
		['adr/0001-x.md', 'a decision record'],
		['CLAUDE.md', 'CLAUDE.md'],
		['sub/CLAUDE.md', 'CLAUDE.md'],
		['.github/workflows/ci.yml', 'a CI workflow or repo setting'],
		['agents/x.md', 'an agent, skill or hook definition'],
		['skills/x/SKILL.md', 'an agent, skill or hook definition'],
		['hooks/pre-push-gate.sh', 'an agent, skill or hook definition']
	])('uses Opus for a tiny change to %s', (path, label) => {
		const result = classify([file(path, 1, 0)]);
		expect(result.model).toBe('opus');
		expect(result.reasons).toEqual([`touches ${label} (${path})`]);
	});

	it('adds the sensitive paths a repo names', () => {
		const extra = [{ pattern: /^migrations\//, label: 'a database migration' }];
		const result = classify([file('migrations/0001.sql', 1, 0)], extra);
		expect(result.reasons).toEqual(['touches a database migration (migrations/0001.sql)']);
		expect(classify([file('migrations/0001.sql', 1, 0)]).model).toBe('sonnet');
	});

	it('names each kind of sensitive path once', () => {
		const result = classify([file('agents/a.md'), file('agents/b.md'), file('CLAUDE.md')]);
		expect(result.reasons).toEqual([
			'touches an agent, skill or hook definition (agents/a.md)',
			'touches CLAUDE.md (CLAUDE.md)'
		]);
	});

	it('parses numstat, counting binary files as zero and keeping tabs in names', () => {
		expect(parseNumstat('3\t1\tsrc/a.ts\n-\t-\timg.png\n\n2\t0\tdir/with\ttab.ts\n')).toEqual([
			{ path: 'src/a.ts', added: 3, deleted: 1 },
			{ path: 'img.png', added: 0, deleted: 0 },
			{ path: 'dir/with\ttab.ts', added: 2, deleted: 0 }
		]);
		expect(parseNumstat('')).toEqual([]);
	});
});

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

interface Fake {
	dirty?: boolean;
	notRepo?: boolean;
	fetchFails?: boolean;
	noBase?: boolean;
	/** No `origin/main`: a new remote. */
	noRemote?: boolean;
	base?: string;
	head?: string;
	numstat?: string;
	diffFails?: boolean;
	timeout?: string;
	existing?: string[];
	/** What `loopgate.json` holds; `null` for none. */
	config?: object | null;
	calls?: string[];
	/** Every git call also prints this on stderr (a warning git would print). */
	noise?: string;
}

function setup(fake: Fake = {}): { deps: PrepareDeps; written: Record<string, string> } {
	const written: Record<string, string> = {};
	const raw: Exec = (_command, args) => {
		const line = args.join(' ');
		fake.calls?.push(line);
		if (fake.timeout !== undefined && line.includes(fake.timeout)) {
			return { code: 1, output: '', timedOut: true };
		}
		if (fake.notRepo) return { code: 128, output: '' };
		const head = fake.head ?? 'abc1234def';
		switch (args[0]) {
			case 'rev-parse':
				if (args[1] === '--verify') return { code: fake.noRemote ? 1 : 0, output: '' };
				return args[1] === '--show-toplevel'
					? { code: 0, output: `/w/example-api\n${head}\n` }
					: { code: 0, output: 'feat/x\n' };
			case 'hash-object':
				return { code: 0, output: `${EMPTY_TREE}\n` };
			case 'status':
				return { code: 0, output: fake.dirty ? ' M a.rs\n' : '' };
			case 'remote':
				return { code: 0, output: 'git@github.com:example-org/example-api.git\n' };
			case 'fetch':
				return { code: fake.fetchFails ? 1 : 0, output: '' };
			case 'merge-base':
				return fake.noBase
					? { code: 1, output: '' }
					: { code: 0, output: `${fake.base ?? 'base000'}\n` };
			case 'diff':
				if (fake.diffFails) return { code: 1, output: '' };
				return args.includes('--numstat')
					? { code: 0, output: fake.numstat ?? '5\t2\tsrc/a.rs\n' }
					: { code: 0, output: 'diff --git a/src/a.rs b/src/a.rs\n+new line\n' };
			default:
				return { code: 0, output: 'abc1234 add a thing\ndef5678 fix it\n' };
		}
	};
	// Like the real runner: `stdout` alone is parseable, `output` also carries stderr.
	const exec: Exec = (command, args, cwd, env, timeoutMs) => {
		const result = raw(command, args, cwd, env, timeoutMs);
		return fake.noise === undefined
			? result
			: { ...result, stdout: result.output, output: `${fake.noise}${result.output}` };
	};
	return {
		deps: {
			exec,
			env: { GIT_TERMINAL_PROMPT: '0' },
			stateDir: '/state',
			exists: (path) =>
				(fake.existing ?? ['/w/example-api/CLAUDE.md', '/w/example-api/spec.md']).includes(path),
			readFile: (path) =>
				path === '/w/example-api/loopgate.json' && fake.config !== null
					? JSON.stringify(fake.config ?? { gates: [] })
					: undefined,
			writeFile: (path, text) => {
				written[path] = text;
			}
		},
		written
	};
}

describe('prepareReview', () => {
	it('describes the push, writes the diff, picks the model and names the rule files', () => {
		const { deps, written } = setup();
		const result = prepareReview('/w/example-api/src', deps);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.prepared).toEqual({
			repo: 'example-api',
			top: '/w/example-api',
			branch: 'feat/x',
			head: 'abc1234def',
			base: 'base000',
			commits: ['abc1234 add a thing', 'def5678 fix it'],
			files: [{ path: 'src/a.rs', added: 5, deleted: 2 }],
			lines: 7,
			model: 'sonnet',
			reasons: [],
			large: false,
			diffPath: '/state/pre-push-review/example-api-abc1234.diff',
			context: ['/w/example-api/CLAUDE.md', '/w/example-api/spec.md'],
			warnings: []
		});
		expect(written['/state/pre-push-review/example-api-abc1234.diff']).toContain('+new line');
	});

	it("adds the repo's own sensitive paths and stops on an invalid config", () => {
		const config = { gates: [], sensitivePaths: [{ pattern: '^src/', label: 'the core' }] };
		const sensitive = prepareReview('/w/example-api', setup({ config }).deps);
		expect(sensitive).toMatchObject({ ok: true, prepared: { model: 'opus' } });
		const invalid = prepareReview('/w/example-api', setup({ config: { gates: 1 } }).deps);
		expect(invalid).toEqual({ ok: false, message: expect.stringContaining('"gates"') as string });
		const none = prepareReview('/w/example-api', setup({ config: null }).deps);
		expect(none).toMatchObject({ ok: true, prepared: { model: 'sonnet' } });
	});

	it('routes to Opus and warns for a large or sensitive diff, a dirty tree and a failed fetch', () => {
		const { deps } = setup({
			dirty: true,
			fetchFails: true,
			numstat: `${LARGE_DIFF_LINES}\t0\tdocs/adr/0009-x.md\n`,
			existing: []
		});
		const result = prepareReview('/w/example-api', deps);
		if (!result.ok) throw new Error(result.message);
		expect(result.prepared.model).toBe('opus');
		expect(result.prepared.large).toBe(true);
		expect(result.prepared.context).toEqual([]);
		expect(result.prepared.warnings).toEqual([
			'git fetch failed or timed out: origin/main may be stale, so the diff may include merged work.',
			'The working tree has uncommitted changes; they are not in this diff and not reviewed.',
			expect.stringMatching(/^1500 changed lines is a large review/)
		]);
	});

	it('parses only stdout, so a git warning cannot corrupt the base, the diff or the file list', () => {
		const { deps, written } = setup({ noise: 'warning: LF will be replaced by CRLF\n' });
		const result = prepareReview('/w/example-api', deps);
		if (!result.ok) throw new Error(result.message);
		expect(result.prepared.base).toBe('base000');
		expect(result.prepared.files).toEqual([{ path: 'src/a.rs', added: 5, deleted: 2 }]);
		expect(result.prepared.commits).toEqual(['abc1234 add a thing', 'def5678 fix it']);
		expect(result.prepared.branch).toBe('feat/x');
		expect(written[result.prepared.diffPath]).not.toMatch(/warning/);
	});

	it('turns off rename detection, so a moved file still shows in its old, sensitive path', () => {
		const calls: string[] = [];
		prepareReview('/w/example-api', setup({ calls }).deps);
		const diffs = calls.filter((c) => c.startsWith('diff '));
		expect(diffs).toHaveLength(2);
		expect(diffs.every((c) => c.includes('--no-renames'))).toBe(true);
	});

	it('reviews the whole tree, with a warning, when the remote has no origin/main', () => {
		const calls: string[] = [];
		const result = prepareReview('/w/example-api', setup({ noRemote: true, calls }).deps);
		if (!result.ok) throw new Error(result.message);
		expect(result.prepared.warnings).toContain(
			'origin/main was not found, so this review covers the whole tree.'
		);
		expect(result.prepared.base).toBe(EMPTY_TREE);
		expect(calls).toContain(`diff --numstat --no-renames ${EMPTY_TREE} HEAD`);
		expect(calls.some((c) => c.startsWith('merge-base'))).toBe(false);
		expect(calls).toContain('hash-object -t tree /dev/null');
		expect(calls).toContain('log --format=%h %s HEAD');
	});

	it('stops when any later git call times out, instead of reading it as "no"', () => {
		for (const call of [
			'merge-base',
			'diff --numstat',
			'diff --no-color',
			'rev-parse --abbrev-ref',
			'log --format'
		]) {
			const result = prepareReview('/w/example-api', setup({ timeout: call }).deps);
			expect(result).toMatchObject({
				ok: false,
				message: expect.stringMatching(/did not answer in time/)
			});
		}
	});

	it('warns, rather than stops, when the fetch times out', () => {
		const result = prepareReview('/w/example-api', setup({ timeout: 'fetch' }).deps);
		if (!result.ok) throw new Error(result.message);
		expect(result.prepared.warnings[0]).toMatch(/git fetch failed or timed out/);
	});

	it('says why there is nothing to review', () => {
		expect(prepareReview('/x', setup({ notRepo: true }).deps)).toEqual({
			ok: false,
			message: '/x is not a git repo with a commit.'
		});
		expect(prepareReview('/w', setup({ noBase: true }).deps)).toMatchObject({
			ok: false,
			message: expect.stringMatching(/No merge base with origin\/main/)
		});
		expect(prepareReview('/w', setup({ head: 'same', base: 'same' }).deps)).toMatchObject({
			ok: false,
			message: expect.stringMatching(/Nothing to review/)
		});
		expect(prepareReview('/w', setup({ diffFails: true }).deps)).toMatchObject({
			ok: false,
			message: expect.stringMatching(/git diff failed/)
		});
	});

	it('stops, rather than guessing, when git times out', () => {
		const result = prepareReview('/w', setup({ timeout: 'status' }).deps);
		expect(result).toMatchObject({
			ok: false,
			message: expect.stringMatching(/did not answer in time.*try again/)
		});
	});

	it('passes unexpected errors through', () => {
		const { deps } = setup();
		deps.exec = () => {
			throw new Error('boom');
		};
		expect(() => prepareReview('/w', deps)).toThrow('boom');
	});
});

describe('log', () => {
	it('writes one numbers-only JSON line', () => {
		const line = logLine({
			ts: 't',
			repo: 'r',
			head: 'h',
			model: 'opus',
			lines: 1,
			high: 0,
			medium: 1,
			low: 2
		});
		expect(line.endsWith('\n')).toBe(true);
		expect(JSON.parse(line)).toEqual({
			ts: 't',
			repo: 'r',
			head: 'h',
			model: 'opus',
			lines: 1,
			high: 0,
			medium: 1,
			low: 2
		});
		expect(logPath('/s')).toBe('/s/pre-push-review-log.jsonl');
	});
});

describe('cli', () => {
	function run(argv: string[], fake: Fake = {}) {
		const { deps } = setup(fake);
		const appended: string[] = [];
		const cliDeps: CliDeps = {
			...deps,
			now: () => new Date('2026-10-18T12:00:00Z'),
			appendFile: (path, text) => appended.push(`${path}|${text}`)
		};
		return { result: main(argv, cliDeps, '/w/example-api'), appended };
	}

	it('prepares the current directory, or the one given', () => {
		const here = run(['prepare']).result;
		expect(here.exitCode).toBe(0);
		expect(JSON.parse(here.stdout)).toMatchObject({ repo: 'example-api', model: 'sonnet' });
		expect(run(['prepare', '/w/example-api']).result.exitCode).toBe(0);
		const failed = run(['prepare'], { noBase: true }).result;
		expect(failed).toMatchObject({ exitCode: 1, stdout: '' });
		expect(failed.stderr).toMatch(/No merge base/);
	});

	it('logs counts to the state directory', () => {
		const args = [
			'log',
			'--repo',
			'example-api',
			'--head',
			'abc1234',
			'--model',
			'sonnet',
			'--lines',
			'40',
			'--high',
			'0',
			'--medium',
			'2',
			'--low',
			'1'
		];
		const { result, appended } = run(args);
		expect(result).toEqual({ exitCode: 0, stdout: 'Logged.\n', stderr: '' });
		expect(appended).toHaveLength(1);
		const [path, text] = (appended[0] as string).split('|');
		expect(path).toBe('/state/pre-push-review-log.jsonl');
		expect(JSON.parse(text as string)).toEqual({
			ts: '2026-10-18T12:00:00.000Z',
			repo: 'example-api',
			head: 'abc1234',
			model: 'sonnet',
			lines: 40,
			high: 0,
			medium: 2,
			low: 1
		});
	});

	it('rejects a missing command, an unknown one, and bad or missing log arguments', () => {
		expect(run([]).result).toMatchObject({ exitCode: 2 });
		expect(run([]).result.stderr).toMatch(/No command given/);
		expect(run(['nope']).result.stderr).toMatch(/Unknown command: nope/);
		expect(run(['log', '--bogus', 'x']).result.exitCode).toBe(2);
		const good = [
			'--repo',
			'r',
			'--head',
			'h',
			'--model',
			'opus',
			'--lines',
			'1',
			'--high',
			'0',
			'--medium',
			'0',
			'--low',
			'0'
		];
		expect(run(['log', ...good]).result.exitCode).toBe(0);
		for (const [flag, bad] of [
			['--model', 'haiku'],
			['--lines', '-1'],
			['--high', 'x'],
			['--low', '1.5']
		]) {
			const argv = [...good];
			argv[argv.indexOf(flag as string) + 1] = bad as string;
			const result = run(['log', ...argv]).result;
			expect(result.exitCode).toBe(2);
			expect(result.stderr).toMatch(/Usage: pre-push-review/);
		}
		for (const flag of ['--repo', '--head', '--medium']) {
			const argv = [...good];
			const at = argv.indexOf(flag);
			argv.splice(at, 2);
			expect(run(['log', ...argv]).result.exitCode).toBe(2);
		}
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

	it('keeps every agent read-only', () => {
		const agents = readdirSync('agents').filter((n) => n.endsWith('.md'));
		expect(agents).toContain('pre-push-reviewer.md');
		for (const name of agents) {
			const tools = (frontmatter(`agents/${name}`)['tools'] ?? '').split(',').map((t) => t.trim());
			expect(tools.every((t) => ['Read', 'Grep', 'Glob'].includes(t))).toBe(true);
		}
	});

	it('defines the reviewer: Opus by default, read-only, one verdict line', () => {
		const meta = frontmatter('agents/pre-push-reviewer.md');
		expect(meta['name']).toBe('pre-push-reviewer');
		expect(meta['model']).toBe('opus');
		const body = readFileSync('agents/pre-push-reviewer.md', 'utf8');
		expect(body).toMatch(/You only read\. You never edit, commit, push or run commands/);
		expect(body).toMatch(/VERDICT: <h> high, <m> medium, <l> low/);
		expect(body).toMatch(/Duplication/);
	});

	it('has a skill that names the commands and the agent that exist', () => {
		const meta = frontmatter('skills/pre-push-review/SKILL.md');
		expect(meta['name']).toBe('pre-push-review');
		const body = readFileSync('skills/pre-push-review/SKILL.md', 'utf8');
		expect(body).toContain('bin/pre-push-review.ts prepare');
		expect(body).toContain('bin/pre-push-review.ts log');
		expect(body).toContain('`pre-push-reviewer` agent');
		expect(body).toMatch(/high/);
	});
});
