import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Exec } from './git.ts';

const MAX_BUFFER = 256 * 1024 * 1024;

// ENOENT also means the working directory does not exist (a clone not made yet): that is "not a repo", not a missing git.
function isUnrunnable(errorCode: string | undefined, cwd: string | undefined): boolean {
	if (errorCode === 'EACCES') return true;
	return errorCode === 'ENOENT' && (cwd === undefined || existsSync(cwd));
}

/**
 * Run a command to completion. `defaultTimeoutMs` applies unless the call names its own; a command
 * that does not finish in time is reported with `timedOut`, not as an ordinary failure.
 */
export function spawnExec(defaultTimeoutMs?: number): Exec {
	return (command, args, cwd, env, timeoutMs) => {
		const run = spawnSync(command, args, {
			cwd,
			env: env ?? process.env,
			encoding: 'utf8',
			maxBuffer: MAX_BUFFER,
			timeout: timeoutMs ?? defaultTimeoutMs
		});
		const errorCode = (run.error as NodeJS.ErrnoException | undefined)?.code;
		const timedOut = errorCode === 'ETIMEDOUT';
		return {
			...(isUnrunnable(errorCode, cwd) ? { unrunnable: true } : {}),
			code: run.status ?? 1,
			output: `${run.stdout ?? ''}${run.stderr ?? ''}${run.error ?? ''}`,
			stdout: run.stdout ?? '',
			timedOut
		};
	};
}

/**
 * `exec` with one time budget for all its calls: each call is limited to `perCallMs` and to what is left, and once
 * nothing is left a call is reported as timed out without running. The hook's 5 second limit is
 * per tool call, however many pushes the command holds.
 */
export function withBudget(
	exec: Exec,
	budgetMs: number,
	perCallMs: number,
	now: () => number = Date.now
): Exec {
	const start = now();
	return (command, args, cwd, env, timeoutMs) => {
		const left = budgetMs - (now() - start);
		if (left <= 0) return { code: 1, output: 'time budget used up\n', timedOut: true };
		return exec(command, args, cwd, env, Math.min(timeoutMs ?? perCallMs, left));
	};
}
