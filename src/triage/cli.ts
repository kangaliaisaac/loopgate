import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { collect, type CollectDeps } from './collect.ts';

export interface CliDeps extends CollectDeps {
	stateDir: string;
	writeFile: (path: string, text: string) => void;
}

export interface CliResult {
	exitCode: 0 | 1 | 2;
	stdout: string;
	stderr: string;
}

const USAGE =
	'Usage: review-triage fetch --pr N --repo OWNER/NAME [--check review] [--author LOGIN,...]\n';

const fail = (message: string, exitCode: 1 | 2): CliResult => ({
	exitCode,
	stdout: '',
	stderr: `${message}\n${exitCode === 2 ? USAGE : ''}`
});

export function main(argv: string[], deps: CliDeps): CliResult {
	const [command = '', ...rest] = argv;
	if (command !== 'fetch') {
		return fail(command === '' ? 'No command given.' : `Unknown command: ${command}`, 2);
	}
	let values;
	try {
		({ values } = parseArgs({
			args: rest,
			options: {
				pr: { type: 'string' },
				repo: { type: 'string' },
				check: { type: 'string' },
				author: { type: 'string' }
			}
		}));
	} catch (error) {
		return fail((error as Error).message, 2);
	}
	if (values.pr === undefined || !/^[1-9]\d*$/.test(values.pr)) {
		return fail('fetch needs --pr N (a pull request number).', 2);
	}
	if (values.repo === undefined || !/^[\w.-]+\/[\w.-]+$/.test(values.repo)) {
		return fail('--repo OWNER/NAME is required: the repo whose pull request is being triaged.', 2);
	}
	try {
		const collected = collect(deps, {
			pr: Number(values.pr),
			check: values.check ?? 'review',
			authors: (values.author ?? '').split(',').filter((a) => a !== ''),
			repo: values.repo
		});
		const path = join(
			deps.stateDir,
			'review-triage',
			`${collected.repo.replace('/', '-')}-pr${collected.pr}.json`
		);
		deps.writeFile(path, `${JSON.stringify(collected, null, 2)}\n`);
		const summary = {
			path,
			repo: collected.repo,
			pr: collected.pr,
			headSha: collected.headSha,
			findings: collected.findings.length,
			unverifiedClaims: collected.findings.filter((f) => f.unverifiedClaim).length,
			stale: collected.findings.filter((f) => f.stale).length,
			siblingShas: collected.siblingShas,
			warnings: collected.warnings
		};
		return { exitCode: 0, stdout: `${JSON.stringify(summary, null, 2)}\n`, stderr: '' };
	} catch (error) {
		return fail((error as Error).message, 1);
	}
}
