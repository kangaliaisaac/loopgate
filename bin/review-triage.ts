// Entry point for review-triage. Thin on purpose: the logic is in src/triage/.
import { homedir } from 'node:os';
import { resolveStateDir } from '../src/config.ts';
import { configOrMessage } from '../src/gates/config.ts';
import { spawnExec } from '../src/gates/exec.ts';
import { readTextFile } from '../src/gates/files.ts';
import { repoState } from '../src/gates/git.ts';
import { realWrite } from '../src/gates/run.ts';
import { main } from '../src/triage/cli.ts';

const exec = spawnExec();
// The sibling repos a finding may name come from the loopgate.json of the repo this runs in.
const top = repoState(process.cwd(), exec)?.top;
const config = top === undefined ? undefined : configOrMessage(top, readTextFile);
const result = main(process.argv.slice(2), {
	exec,
	// gh must never wait at a prompt.
	env: { ...process.env, GH_PROMPT_DISABLED: '1' },
	cwd: process.cwd(),
	siblingRepos: typeof config === 'object' ? config.siblingRepos : [],
	stateDir: resolveStateDir(process.env, homedir()),
	writeFile: realWrite
});
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.exitCode);
