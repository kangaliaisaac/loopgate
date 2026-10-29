// Entry point for the CI gate runner. Thin on purpose: the logic is in src/gates/.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolveStateDir } from '../src/config.ts';
import { spawnExec } from '../src/gates/exec.ts';
import { readTextFile } from '../src/gates/files.ts';
import { realWrite, runGates } from '../src/gates/run.ts';

const stateDir = resolveStateDir(process.env, homedir());
const result = runGates(process.argv[2] ?? process.cwd(), {
	exec: spawnExec(),
	exists: existsSync,
	now: () => new Date(),
	stateDir,
	env: process.env,
	readFile: readTextFile,
	writeFile: realWrite
});
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.exitCode);
