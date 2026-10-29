import { describe, expect, it } from 'vitest';
import {
	ConfigError,
	configOrMessage,
	databaseHost,
	databaseName,
	isTestDatabase,
	loadConfig,
	parseConfig
} from '../src/gates/config.ts';
import { GitUnavailable, remoteName, repoState, stdoutOf, type Exec } from '../src/gates/git.ts';
import { parseRecord, recordPath } from '../src/gates/record.ts';
import { realWrite, runGates, type RunDeps } from '../src/gates/run.ts';
import { gatesBlock } from '../src/gates/status.ts';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Fake {
	top?: string;
	head?: string;
	status?: string;
	notRepo?: boolean;
	/** `git status` fails although `rev-parse` worked. */
	statusFails?: boolean;
	/** The origin URL; `null` for a repo with no origin. Default: GitHub, named after `top`. */
	origin?: string | null;
	fail?: string;
	/** A command line (git or gate) containing this text times out. */
	timeout?: string;
	/** git cannot be started at all (missing, not executable). */
	unrunnable?: boolean;
	/** Paths that exist for the environment check (default: all). */
	missing?: string[];
	calls?: string[];
	/** What `loopgate.json` holds (default: `APP_CONFIG`); `null` for a repo with no file. */
	config?: object | null;
}

const APP_CONFIG = {
	gates: [
		{ name: 'lint', command: 'npm', args: ['run', 'lint'] },
		{ name: 'check', command: 'npm', args: ['run', 'check'] },
		{ name: 'test', command: 'npm', args: ['test'] },
		{ name: 'build', command: 'npm', args: ['run', 'build'] },
		{ name: 'audit', command: 'npx', args: ['audit-ci', '--config', 'audit-ci.jsonc'] }
	],
	environment: { path: 'node_modules', fix: 'run `npm ci`' }
};

const SERVICE_CONFIG = {
	gates: [
		{ name: 'lint', command: './.venv/bin/python', args: ['-m', 'ruff', 'check', '.'] },
		{
			name: 'migrate',
			command: './.venv/bin/python',
			args: ['-m', 'tool', 'up'],
			needsTestDb: true
		},
		{ name: 'pytest', command: './.venv/bin/python', args: ['-m', 'pytest'], needsTestDb: true }
	],
	environment: { path: '.venv/bin/python', fix: 'create the virtualenv' }
};

function configText(fake: Fake): string | undefined {
	return fake.config === null ? undefined : JSON.stringify(fake.config ?? APP_CONFIG);
}

function fakeExec(fake: Fake): Exec {
	return (command, args, cwd) => {
		const line = `${command} ${args.join(' ')}`;
		fake.calls?.push(`${cwd}: ${line}`);
		if (fake.timeout !== undefined && line.includes(fake.timeout)) {
			return { code: 1, output: 'partial\n', timedOut: true };
		}
		if (command === 'git') {
			if (fake.unrunnable) return { code: 1, output: 'spawnSync git ENOENT', unrunnable: true };
			if (fake.notRepo) return { code: 128, output: '' };
			if (args[0] === 'rev-parse') {
				return {
					code: 0,
					output: `${fake.top ?? '/w/example-app'}\n${fake.head ?? 'abc1234def'}\n`
				};
			}
			if (args[0] === 'remote') {
				if (fake.origin === null) return { code: 2, output: '' };
				const top = fake.top ?? '/w/example-app';
				return {
					code: 0,
					output: fake.origin ?? `git@github.com:example-org/${top.split('/').pop()}.git\n`
				};
			}
			return fake.statusFails ? { code: 128, output: '' } : { code: 0, output: fake.status ?? '' };
		}
		return fake.fail !== undefined && line.includes(fake.fail)
			? { code: 3, output: `${'noise\n'.repeat(100)}boom\n` }
			: { code: 0, output: '' };
	};
}

function deps(
	fake: Fake = {},
	files: Record<string, string> = {},
	env = {}
): RunDeps & {
	written: Record<string, string>;
} {
	const written: Record<string, string> = {};
	let tick = 0;
	return {
		exec: fakeExec(fake),
		now: () => new Date(Date.UTC(2026, 9, 18, 12, 0, tick++ * 2)),
		stateDir: '/state',
		env,
		exists: (path) => !(fake.missing ?? []).some((m) => path.endsWith(m)),
		readFile: (path) =>
			written[path] ??
			files[path] ??
			(path.endsWith('/loopgate.json') ? configText(fake) : undefined),
		writeFile: (path, text) => {
			written[path] = text;
		},
		written
	};
}

describe('config', () => {
	it('reads the database name from a URL', () => {
		expect(databaseName('postgres://u:p@h:5432/app_test')).toBe('app_test');
		expect(databaseName('postgres://u@h/app?sslmode=x')).toBe('app');
		expect(databaseName(undefined)).toBeUndefined();
		expect(isTestDatabase('postgres://u@localhost/app_test')).toBe(true);
		expect(isTestDatabase('postgres://u@h/app')).toBe(false);
		expect(isTestDatabase(undefined)).toBe(false);
		expect(isTestDatabase('postgres://u@localhost:5432/app_test')).toBe(true);
		expect(isTestDatabase('postgres://u@127.0.0.1/app_test')).toBe(true);
		expect(isTestDatabase('postgres://u@[::1]/app_test')).toBe(true);
		expect(isTestDatabase('postgres://u@db.example.com/app_test')).toBe(false);
		expect(isTestDatabase('postgres://u@localhost/app')).toBe(false);
		expect(isTestDatabase('x/app_test')).toBe(false);
		expect(isTestDatabase('postgres://u@localhost/app_test?sslmode=disable')).toBe(true);
		for (const query of [
			'host=db.example.com',
			'hostaddr=10.0.0.1',
			'dbname=app',
			'service=prod'
		]) {
			expect(isTestDatabase(`postgres://u@localhost/app_test?x=1&${query}`)).toBe(false);
			expect(isTestDatabase(`postgres://u@localhost/app_test?${query}#f`)).toBe(false);
		}
		expect(databaseHost('postgres://u:p@localhost:5432/x')).toBe('localhost');
		expect(databaseHost('not a url')).toBeUndefined();
		expect(databaseHost(undefined)).toBeUndefined();
	});
});

describe('config file', () => {
	it('fills in the defaults', () => {
		expect(parseConfig('{"gates":[{"name":"a","command":"b"}]}')).toEqual({
			gates: [{ name: 'a', command: 'b', args: [] }],
			testDatabaseEnv: 'DATABASE_URL',
			siblingRepos: [],
			sensitivePaths: []
		});
	});

	it('reads every key', () => {
		const config = parseConfig(
			JSON.stringify({
				...SERVICE_CONFIG,
				testDatabaseEnv: 'TEST_DB',
				siblingRepos: ['other'],
				sensitivePaths: [{ pattern: '^migrations/', label: 'a migration' }]
			})
		);
		expect(config.gates[1]).toEqual({
			name: 'migrate',
			command: './.venv/bin/python',
			args: ['-m', 'tool', 'up'],
			needsTestDb: true
		});
		expect(config.environment).toEqual(SERVICE_CONFIG.environment);
		expect(config.testDatabaseEnv).toBe('TEST_DB');
		expect(config.siblingRepos).toEqual(['other']);
		expect(config.sensitivePaths[0]?.pattern.test('migrations/1.sql')).toBe(true);
		const timed = parseConfig('{"gates":[{"name":"a","command":"b","timeoutMs":5}]}');
		expect(timed.gates[0]?.timeoutMs).toBe(5);
	});

	it('names the key that is wrong', () => {
		const bad = (text: string) => () => parseConfig(text);
		const gate = (extra: string) => `{"gates":[{"name":"a","command":"b"${extra}}]}`;
		expect(bad('nope')).toThrow('not valid JSON');
		expect(bad('[]')).toThrow('"config" must be an object');
		expect(bad('{}')).toThrow('"gates" must be an array');
		expect(bad('{"gates":[],"gate":1}')).toThrow('"config.gate" must be one of');
		expect(bad('{"gates":[1]}')).toThrow('"gates[0]" must be an object');
		expect(bad('{"gates":[{"name":"","command":"b"}]}')).toThrow('"gates[0].name"');
		expect(bad(gate(',"args":[1]'))).toThrow('"gates[0].args" must be an array of strings');
		expect(bad(gate(',"args":"x"'))).toThrow('"gates[0].args"');
		expect(bad(gate(',"timeoutMs":0'))).toThrow('"gates[0].timeoutMs" must be a positive');
		expect(bad(gate(',"timeoutMs":"1"'))).toThrow('"gates[0].timeoutMs"');
		expect(bad(gate(',"needsTestDb":1'))).toThrow('"gates[0].needsTestDb"');
		expect(bad('{"gates":[],"testDatabaseEnv":""}')).toThrow('"testDatabaseEnv"');
		expect(bad('{"gates":[],"siblingRepos":"x"}')).toThrow('"siblingRepos"');
		expect(bad('{"gates":[],"environment":{"path":"p"}}')).toThrow('"environment.fix"');
		expect(bad('{"gates":[],"sensitivePaths":{}}')).toThrow('"sensitivePaths" must be an array');
		expect(bad('{"gates":[],"sensitivePaths":[{"pattern":"(","label":"l"}]}')).toThrow(
			'"sensitivePaths[0].pattern" must be a valid regular expression'
		);
	});

	it('is looked up at the top of the work tree only', () => {
		const seen: string[] = [];
		const read = (path: string) => {
			seen.push(path);
			return undefined;
		};
		expect(loadConfig('/w/app', read)).toBeUndefined();
		expect(seen).toEqual(['/w/app/loopgate.json']);
		expect(() => loadConfig('/w/app', () => '{')).toThrow(ConfigError);
		expect(configOrMessage('/w/app', () => '{')).toContain('not valid JSON');
		expect(() =>
			configOrMessage('/w/app', () => {
				throw new Error('disk');
			})
		).toThrow('disk');
	});
});

describe('record', () => {
	it('parses a record and treats anything unreadable as empty', () => {
		expect(parseRecord('{"/a":{"head":"x","passedAt":"t"}}')).toEqual({
			'/a': { head: 'x', passedAt: 't' }
		});
		expect(parseRecord(undefined)).toEqual({});
		expect(parseRecord('nope')).toEqual({});
		expect(parseRecord('[1]')).toEqual({});
		expect(parseRecord('null')).toEqual({});
		expect(recordPath('/s')).toBe('/s/ci-gate-pass.json');
	});
});

describe('repoState', () => {
	it('describes a repo and returns undefined outside one', () => {
		expect(repoState('/w/example-app/src', fakeExec({ status: ' M a' }))).toEqual({
			top: '/w/example-app',
			name: 'example-app',
			head: 'abc1234def',
			dirty: true
		});
		expect(repoState('/x', fakeExec({ notRepo: true }))).toBeUndefined();
	});

	it('reads only stdout, so a git warning on stderr cannot change the HEAD, the status or the name', () => {
		const noisy: Exec = (command, args, cwd, env, timeoutMs) => {
			const result = fakeExec({ status: ' M a' })(command, args, cwd, env, timeoutMs);
			return { ...result, stdout: result.output, output: `warning: noise\n${result.output}` };
		};
		expect(repoState('/w/example-app', noisy)).toEqual({
			top: '/w/example-app',
			name: 'example-app',
			head: 'abc1234def',
			dirty: true
		});
		expect(stdoutOf({ output: 'both', stdout: 'only' })).toBe('only');
		expect(stdoutOf({ output: 'both' })).toBe('both');
		expect(stdoutOf({ output: 'both', stdout: '' })).toBe('');
	});

	it('throws GitUnavailable when any git call times out, and stays quiet for a plain non-repo', () => {
		for (const timeout of ['rev-parse', 'status', 'remote']) {
			expect(() => repoState('/w/example-app', fakeExec({ timeout }))).toThrow(GitUnavailable);
		}
		expect(() => repoState('/w/example-app', fakeExec({ unrunnable: true }))).toThrow(
			/git could not be run/
		);
		expect(() => repoState('/x', fakeExec({ notRepo: true }))).not.toThrow();
		expect(repoState('/x', fakeExec({ statusFails: true }))).toBeUndefined();
	});

	it('names a repo from its origin, so a worktree or a renamed clone keeps its gates', () => {
		const origin = 'https://github.com/example-org/example-app.git\n';
		expect(repoState('/w/feat-x', fakeExec({ top: '/w/feat-x', origin }))?.name).toBe(
			'example-app'
		);
		expect(repoState('/w/ui-clone', fakeExec({ top: '/w/ui-clone', origin: null }))?.name).toBe(
			'ui-clone'
		);
		expect(remoteName('git@github.com:example-org/example-lib.git')).toBe('example-lib');
		expect(remoteName('https://github.com/example-org/example-lib/')).toBe('example-lib');
		expect(remoteName('ssh://git@host/x/example-docs')).toBe('example-docs');
	});

	it('runs the gates of the repo a worktree belongs to', () => {
		const d = deps({ top: '/w/feat-x', origin: 'git@github.com:example-org/example-app.git' });
		expect(runGates('/w/feat-x', d).stdout).toContain('ok lint');
	});
});

describe('runGates', () => {
	it('runs every gate in order and records the pass for the commit', () => {
		const calls: string[] = [];
		const d = deps({ calls });
		const result = runGates('/w/example-app', d);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('ok lint');
		expect(result.stdout).toContain('All gates passed for example-app at abc1234');
		expect(result.stdout).toMatch(
			/Next: run the pre-push review \(skill `pre-push-review`\), then push\.\n$/
		);
		const ran = calls.filter((c) => !c.includes('git')).map((c) => c.split(': ')[1]);
		expect(ran).toEqual([
			'npm run lint',
			'npm run check',
			'npm test',
			'npm run build',
			'npx audit-ci --config audit-ci.jsonc'
		]);
		expect(JSON.parse(d.written['/state/ci-gate-pass.json'] as string)).toEqual({
			'/w/example-app': {
				head: 'abc1234def',
				passedAt: expect.stringMatching(/^2026-10-18T12:00:\d\d\.000Z$/) as string
			}
		});
	});

	it('keeps other repos in the record', () => {
		const d = deps({}, { '/state/ci-gate-pass.json': '{"/other":{"head":"h","passedAt":"t"}}' });
		runGates('/w/example-app', d);
		expect(Object.keys(JSON.parse(d.written['/state/ci-gate-pass.json'] as string))).toEqual([
			'/other',
			'/w/example-app'
		]);
	});

	it('stops at the first failure, shows the tail of its output and records nothing', () => {
		const calls: string[] = [];
		const d = deps({ fail: 'npm test', calls });
		const result = runGates('/w/example-app', d);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toMatch(/^FAILED test \(exit 3, \d+s\):/);
		expect(result.stderr.split('\n').length).toBeLessThan(70);
		expect(result.stderr).toContain('boom');
		expect(result.stdout).toContain('ok lint');
		expect(calls.some((c) => c.includes('npm run build'))).toBe(false);
		expect(d.written).toEqual({});
	});

	it('refuses a dirty tree, a non-repo, and says when a repo has no gates', () => {
		expect(runGates('/w/example-app', deps({ status: ' M a' })).stderr).toMatch(/uncommitted/);
		expect(runGates('/w/example-app', deps({ status: ' M a' })).exitCode).toBe(2);
		expect(runGates('/x', deps({ notRepo: true }))).toMatchObject({ exitCode: 2 });
		const none = runGates('/w/example-docs', deps({ top: '/w/example-docs', config: null }));
		expect(none).toMatchObject({ exitCode: 0 });
		expect(none.stdout).toMatch(/no loopgate\.json, so it has no gates/);
		const broken = runGates('/w/example-app', deps({ config: { gates: 1 } }));
		expect(broken).toMatchObject({ exitCode: 2, stdout: '' });
		expect(broken.stderr).toContain('"gates" must be an array');
	});

	it('resolves a relative command and refuses database gates on a non-test database', () => {
		const calls: string[] = [];
		const url = 'postgres://u:p@localhost/app';
		const bad = runGates(
			'/w/example-service',
			deps({ top: '/w/example-service', calls, config: SERVICE_CONFIG }, {}, { DATABASE_URL: url })
		);
		expect(bad.exitCode).toBe(1);
		expect(bad.stderr).toMatch(
			/FAILED migrate: DATABASE_URL must point at a \*_test database on this machine \(got app on localhost\)/
		);
		expect(
			calls.some((c) => c.includes('/w/example-service/.venv/bin/python -m ruff check .'))
		).toBe(true);
		const unset = runGates(
			'/w/example-service',
			deps({ top: '/w/example-service', config: SERVICE_CONFIG })
		);
		expect(unset.stderr).toMatch(/got none/);
		const ok = runGates(
			'/w/example-service',
			deps(
				{ top: '/w/example-service', config: SERVICE_CONFIG },
				{},
				{ DATABASE_URL: 'postgres://u:p@localhost/app_test' }
			)
		);
		expect(ok.exitCode).toBe(0);
	});

	it('reads the test database from the variable the config names', () => {
		const config = { ...SERVICE_CONFIG, testDatabaseEnv: 'TEST_DB' };
		const run = (env: Record<string, string>) =>
			runGates('/w/example-service', deps({ top: '/w/example-service', config }, {}, env));
		expect(run({ DATABASE_URL: 'postgres://u@localhost/app_test' }).stderr).toMatch(
			/FAILED migrate: TEST_DB must point at/
		);
		expect(run({ TEST_DB: 'postgres://u@localhost/app_test' }).exitCode).toBe(0);
	});

	it('refuses a remote or unreadable database for the database gates', () => {
		const run = (url: string) =>
			runGates(
				'/w/example-service',
				deps({ top: '/w/example-service', config: SERVICE_CONFIG }, {}, { DATABASE_URL: url })
			);
		expect(run('postgres://u@db.example.com/app_test').stderr).toMatch(
			/got app_test on db\.example\.com/
		);
		expect(run('app_test').stderr).toMatch(/got none/);
		expect(run('x/app_test').stderr).toMatch(/got app_test on an unreadable host/);
		expect(run('postgres://u:p@w:x@y/app_test').stderr).toMatch(/FAILED migrate/);
	});

	it('names what a fresh worktree is missing before running anything', () => {
		const calls: string[] = [];
		const nodeRepo = runGates(
			'/w/feat-x',
			deps({
				top: '/w/feat-x',
				origin: 'git@github.com:example-org/example-app.git',
				calls,
				missing: ['node_modules']
			})
		);
		expect(nodeRepo).toMatchObject({ exitCode: 2, stdout: '' });
		expect(nodeRepo.stderr).toMatch(/example-app at \/w\/feat-x has no node_modules: run `npm ci`/);
		expect(calls.some((c) => c.includes('npm'))).toBe(false);
		const pythonRepo = runGates(
			'/w/w2',
			deps({
				top: '/w/w2',
				origin: 'git@github.com:example-org/example-service.git',
				missing: ['.venv/bin/python'],
				config: SERVICE_CONFIG
			})
		);
		expect(pythonRepo.stderr).toMatch(/no \.venv\/bin\/python: create the virtualenv/);
		const noEnvRepo = runGates(
			'/w/example-lib',
			deps({
				top: '/w/example-lib',
				missing: ['node_modules'],
				config: { gates: APP_CONFIG.gates }
			})
		);
		expect(noEnvRepo.exitCode).toBe(0);
	});

	it('stops a gate that hangs and shows what it printed', () => {
		const result = runGates('/w/example-app', deps({ timeout: 'npm test' }));
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toMatch(
			/^TIMED OUT test after 1200s \(a hung gate\); last output:\npartial/
		);
	});

	it('does not run anything when git itself times out', () => {
		const calls: string[] = [];
		const result = runGates('/w/example-app', deps({ timeout: 'status', calls }));
		expect(result).toMatchObject({ exitCode: 2, stdout: '' });
		expect(result.stderr).toMatch(/git did not answer in time.*Nothing was run/);
		expect(calls.some((c) => c.includes('npm'))).toBe(false);
	});

	it('passes other errors through', () => {
		const d = deps();
		d.exec = () => {
			throw new Error('boom');
		};
		expect(() => runGates('/w/example-app', d)).toThrow('boom');
	});

	it('writes the record file for real', () => {
		const dir = mkdtempSync(join(tmpdir(), 'gate-'));
		realWrite(join(dir, 'nested', 'ci-gate-pass.json'), '{}');
		expect(readFileSync(join(dir, 'nested', 'ci-gate-pass.json'), 'utf8')).toBe('{}');
	});
});

describe('gatesBlock', () => {
	const record = (head: string, top = '/w/example-app') =>
		JSON.stringify({ [top]: { head, passedAt: 't' } });
	const status = (fake: Fake, files: Record<string, string> = {}) =>
		gatesBlock('/w/example-app/src', {
			exec: fakeExec(fake),
			stateDir: '/state',
			runnerPath: '/t/bin/ci-gate-runner.ts',
			readFile: (path) =>
				files[path] ?? (path.endsWith('/loopgate.json') ? configText(fake) : undefined)
		});

	it('allows a commit whose gates passed', () => {
		expect(status({}, { '/state/ci-gate-pass.json': record('abc1234def') })).toBeUndefined();
	});

	it('blocks with the command to run when there is no pass for this commit', () => {
		const none = status({});
		expect(none).toContain('have not passed for example-app at abc1234');
		expect(none).toContain('node "/t/bin/ci-gate-runner.ts"');
		expect(none).toContain('from "/w/example-app"');
		expect(status({}, { '/state/ci-gate-pass.json': record('older') })).toMatch(/have not passed/);
		expect(status({}, { '/state/ci-gate-pass.json': record('abc1234def', '/other') })).toMatch(
			/have not passed/
		);
	});

	it('blocks a dirty tree even when the commit passed', () => {
		const files = { '/state/ci-gate-pass.json': record('abc1234def') };
		expect(status({ status: ' M a' }, files)).toMatch(/uncommitted changes.*Commit first/);
	});

	it('blocks, rather than allows, when git times out', () => {
		const reason = status({ timeout: 'status' });
		expect(reason).toMatch(/git did not answer in time.*could not be checked; retry/);
		expect(status({ timeout: 'rev-parse' })).toMatch(/retry the push/);
	});

	it('passes unexpected errors through', () => {
		expect(() =>
			gatesBlock('/x', {
				exec: () => {
					throw new Error('boom');
				},
				stateDir: '/state',
				runnerPath: '/r',
				readFile: () => undefined
			})
		).toThrow('boom');
	});

	it('tells the user to install dependencies in a fresh worktree', () => {
		expect(status({})).toMatch(/In a fresh git worktree, install the dependencies there first/);
	});

	it('blocks, rather than allows, when the config is invalid', () => {
		expect(status({ config: { gates: 1 } })).toContain('"gates" must be an array');
	});

	it('allows repos with no gates and directories that are not repos', () => {
		expect(status({ top: '/w/example-docs', config: null })).toBeUndefined();
		expect(status({ notRepo: true })).toBeUndefined();
	});
});
