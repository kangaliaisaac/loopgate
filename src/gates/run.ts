import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	configOrMessage,
	DEFAULT_GATE_TIMEOUT_MS,
	databaseHost,
	databaseName,
	isTestDatabase
} from './config.ts';
import { GitUnavailable, repoState, type Exec } from './git.ts';
import { parseRecord, recordPath, type RecordIo } from './record.ts';

export interface RunDeps extends RecordIo {
	exec: Exec;
	now: () => Date;
	stateDir: string;
	env: Record<string, string | undefined>;
	/** Whether a path exists (a seam for tests). */
	exists: (path: string) => boolean;
	/** Writes the record (a seam for tests). */
	writeFile: (path: string, text: string) => void;
}

export interface GateResult {
	exitCode: 0 | 1 | 2;
	stdout: string;
	stderr: string;
}

const TAIL_LINES = 60;

function tail(output: string): string {
	return output.trimEnd().split('\n').slice(-TAIL_LINES).join('\n');
}

export function realWrite(path: string, text: string): void {
	mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, text);
	renameSync(temp, path);
}

/** Run the repo's gates one at a time, stopping at the first failure; record a full pass. */
export function runGates(dir: string, deps: RunDeps): GateResult {
	try {
		return runGatesIn(dir, deps);
	} catch (error) {
		if (!(error instanceof GitUnavailable)) throw error;
		return { exitCode: 2, stdout: '', stderr: `${error.message} Nothing was run; try again.\n` };
	}
}

function runGatesIn(dir: string, deps: RunDeps): GateResult {
	const repo = repoState(dir, deps.exec);
	if (repo === undefined)
		return {
			exitCode: 2,
			stdout: '',
			stderr: `${dir} is not a git repo with a commit; commit once so a pass can be recorded.\n`
		};
	const loaded = configOrMessage(repo.top, deps.readFile);
	if (typeof loaded === 'string') return { exitCode: 2, stdout: '', stderr: `${loaded}\n` };
	if (loaded === undefined) {
		return {
			exitCode: 0,
			stdout: `${repo.name} has no loopgate.json, so it has no gates; nothing to run.\n`,
			stderr: ''
		};
	}
	const { gates, environment: needed, testDatabaseEnv } = loaded;
	if (repo.dirty) {
		return {
			exitCode: 2,
			stdout: '',
			stderr: `${repo.name} has uncommitted changes. Commit first: a pass is recorded for a commit.\n`
		};
	}
	if (needed !== undefined && !deps.exists(join(repo.top, needed.path))) {
		return {
			exitCode: 2,
			stdout: '',
			stderr:
				`${repo.name} at ${repo.top} has no ${needed.path}: ${needed.fix}, then run the gates again. ` +
				`(A fresh git worktree does not share it with the main checkout.)\n`
		};
	}
	let stdout = '';
	for (const gate of gates) {
		if (gate.needsTestDb && !isTestDatabase(deps.env[testDatabaseEnv])) {
			return {
				exitCode: 1,
				stdout,
				stderr:
					`FAILED ${gate.name}: ${testDatabaseEnv} must point at a *_test database on this machine ` +
					`(got ${describeDatabase(deps.env[testDatabaseEnv])}). Not run.\n`
			};
		}
		const started = deps.now().getTime();
		const command = gate.command.startsWith('./')
			? `${repo.top}/${gate.command.slice(2)}`
			: gate.command;
		const limit = gate.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
		const result = deps.exec(command, gate.args, repo.top, deps.env, limit);
		const seconds = Math.round((deps.now().getTime() - started) / 1000);
		if (result.timedOut) {
			return {
				exitCode: 1,
				stdout,
				stderr: `TIMED OUT ${gate.name} after ${Math.round(limit / 1000)}s (a hung gate); last output:\n${tail(result.output)}\n`
			};
		}
		if (result.code !== 0) {
			return {
				exitCode: 1,
				stdout,
				stderr: `FAILED ${gate.name} (exit ${result.code}, ${seconds}s):\n${tail(result.output)}\n`
			};
		}
		stdout += `ok ${gate.name} (${seconds}s)\n`;
	}
	const path = recordPath(deps.stateDir);
	const record = parseRecord(deps.readFile(path));
	record[repo.top] = { head: repo.head, passedAt: deps.now().toISOString() };
	deps.writeFile(path, JSON.stringify(record, null, 2));
	return {
		exitCode: 0,
		stdout:
			`${stdout}All gates passed for ${repo.name} at ${repo.head.slice(0, 7)}.\n` +
			'Next: run the pre-push review (skill `pre-push-review`), then push.\n',
		stderr: ''
	};
}

function describeDatabase(url: string | undefined): string {
	const name = databaseName(url);
	return name === undefined ? 'none' : `${name} on ${databaseHost(url) ?? 'an unreadable host'}`;
}
