// Entry point for the pre-push review helper. Thin on purpose: the logic is in src/review/.
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { resolveStateDir } from '../src/config.ts';
import { spawnExec } from '../src/gates/exec.ts';
import { readTextFile } from '../src/gates/files.ts';
import { realWrite } from '../src/gates/run.ts';
import { main } from '../src/review/cli.ts';

const home = homedir();
const result = main(
	process.argv.slice(2),
	{
		// A git call that does not answer in a minute is a failure, never a hang.
		exec: spawnExec(60_000),
		// Never wait at a credential prompt: the fetch fails and prepare warns instead.
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
		stateDir: resolveStateDir(process.env, home),
		exists: existsSync,
		readFile: readTextFile,
		writeFile: realWrite,
		now: () => new Date(),
		appendFile: (path, text) => {
			mkdirSync(dirname(path), { recursive: true });
			appendFileSync(path, text);
		}
	},
	process.cwd()
);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
if (result.exitCode !== 0) process.exit(result.exitCode);
