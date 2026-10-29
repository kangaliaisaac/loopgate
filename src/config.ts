import { join } from 'node:path';

export type Env = Record<string, string | undefined>;

/** Where tool state (gate passes, review logs and diffs) lives; an empty override falls back. */
export function resolveStateDir(env: Env, homeDir: string): string {
	return env['LOOPGATE_STATE_DIR'] || join(homeDir, '.local', 'state', 'loopgate');
}
