import { parseArgs } from 'node:util';
import { logLine, logPath } from './log.ts';
import { prepareReview, type PrepareDeps } from './prepare.ts';

export interface CliDeps extends PrepareDeps {
	now: () => Date;
	appendFile: (path: string, text: string) => void;
}

export interface CliResult {
	exitCode: 0 | 1 | 2;
	stdout: string;
	stderr: string;
}

const USAGE =
	'Usage: pre-push-review prepare [dir]\n' +
	'       pre-push-review log --repo NAME --head SHA --model opus|sonnet --lines N --high N --medium N --low N\n';

const usage = (message: string): CliResult => ({
	exitCode: 2,
	stdout: '',
	stderr: `${message}\n${USAGE}`
});

export function main(argv: string[], deps: CliDeps, cwd: string): CliResult {
	const [command = '', ...rest] = argv;
	if (command === 'prepare') {
		const result = prepareReview(rest[0] ?? cwd, deps);
		return result.ok
			? { exitCode: 0, stdout: `${JSON.stringify(result.prepared, null, 2)}\n`, stderr: '' }
			: { exitCode: 1, stdout: '', stderr: `${result.message}\n` };
	}
	if (command === 'log') return log(rest, deps);
	return usage(command === '' ? 'No command given.' : `Unknown command: ${command}`);
}

function log(args: string[], deps: CliDeps): CliResult {
	let values;
	try {
		({ values } = parseArgs({
			args,
			options: {
				repo: { type: 'string' },
				head: { type: 'string' },
				model: { type: 'string' },
				lines: { type: 'string' },
				high: { type: 'string' },
				medium: { type: 'string' },
				low: { type: 'string' }
			}
		}));
	} catch (error) {
		return usage((error as Error).message);
	}
	const count = (value: string | undefined) =>
		value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;
	const lines = count(values.lines);
	const high = count(values.high);
	const medium = count(values.medium);
	const low = count(values.low);
	const model = values.model;
	if (
		values.repo === undefined ||
		values.head === undefined ||
		(model !== 'opus' && model !== 'sonnet') ||
		lines === undefined ||
		high === undefined ||
		medium === undefined ||
		low === undefined
	) {
		return usage(
			'log needs --repo, --head, --model opus|sonnet and whole-number --lines, --high, --medium, --low.'
		);
	}
	deps.appendFile(
		logPath(deps.stateDir),
		logLine({
			ts: deps.now().toISOString(),
			repo: values.repo,
			head: values.head,
			model,
			lines,
			high,
			medium,
			low
		})
	);
	return { exitCode: 0, stdout: 'Logged.\n', stderr: '' };
}
