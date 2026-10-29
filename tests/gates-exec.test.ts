import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Exec } from '../src/gates/git.ts';
import { spawnExec, withBudget } from '../src/gates/exec.ts';

const NODE = process.execPath;

describe('spawnExec', () => {
	it('returns the exit code and combined output', () => {
		const exec = spawnExec();
		const ok = exec(NODE, ['-e', 'console.log("out"); console.error("err")'], process.cwd());
		expect(ok).toEqual({ code: 0, output: 'out\nerr\n', stdout: 'out\n', timedOut: false });
		const failed = exec(NODE, ['-e', 'process.exit(3)'], process.cwd());
		expect(failed).toMatchObject({ code: 3, timedOut: false });
	});

	it('passes the environment given, else the process environment', () => {
		const exec = spawnExec();
		const read = ['-e', 'console.log(process.env.GATE_TEST ?? "unset")'];
		expect(exec(NODE, read, process.cwd(), { GATE_TEST: 'x' }).output).toBe('x\n');
		expect(exec(NODE, read, process.cwd()).output).toBe('unset\n');
	});

	it('reports a command that does not finish in time as timed out', () => {
		const slow = ['-e', 'setTimeout(() => {}, 5000)'];
		expect(spawnExec(100)(NODE, slow, process.cwd())).toMatchObject({ timedOut: true });
		expect(spawnExec(5000)(NODE, slow, process.cwd(), undefined, 100)).toMatchObject({
			timedOut: true
		});
	});

	it('reports a command that cannot start as a failure, not a timeout', () => {
		const result = spawnExec()('no-such-command-xyz', [], process.cwd());
		expect(result).toMatchObject({ code: 1, timedOut: false, unrunnable: true });
		expect(result.output).toMatch(/ENOENT/);
	});

	it('reads a missing working directory as a failure, not an unrunnable git', () => {
		const result = spawnExec()('git', ['status'], '/no/such/dir/xyz');
		expect(result).toMatchObject({ code: 1, timedOut: false });
		expect(result.unrunnable).toBeUndefined();
	});

	it('reads a command that is not executable as unrunnable', () => {
		const dir = mkdtempSync(join(tmpdir(), 'exec-eacces-'));
		const file = join(dir, 'tool');
		writeFileSync(file, '#!/bin/sh\n', { mode: 0o644 });
		expect(spawnExec()(file, [], dir)).toMatchObject({ unrunnable: true });
		rmSync(dir, { recursive: true });
	});

	it('reads a missing command with no working directory as unrunnable', () => {
		expect(spawnExec()('no-such-command-xyz', [], undefined as unknown as string)).toMatchObject({
			unrunnable: true
		});
	});

	it('shares one time budget across calls', () => {
		let now = 0;
		const seen: Array<number | undefined> = [];
		const inner: Exec = (_c, _a, _d, _e, timeoutMs) => {
			seen.push(timeoutMs);
			now += 1000;
			return { code: 0, output: '' };
		};
		const exec = withBudget(inner, 2500, 1200, () => now);
		expect(exec('git', [], '/')).toMatchObject({ code: 0 });
		expect(exec('git', [], '/', undefined, 1200)).toMatchObject({ code: 0 });
		expect(exec('git', [], '/', undefined, 400)).toMatchObject({ code: 0 });
		expect(seen).toEqual([1200, 1200, 400]);
		now = 2400;
		exec('git', [], '/', undefined, 1200);
		expect(seen.at(-1)).toBe(100);
		now = 2500;
		expect(exec('git', [], '/')).toMatchObject({ timedOut: true });
		expect(seen).toHaveLength(4);
	});
});
