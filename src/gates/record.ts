import { join } from 'node:path';

export const GATE_RECORD_FILE = 'ci-gate-pass.json';

/** Per repo (its top-level path): the commit whose gates all passed. */
export type GateRecord = Record<string, { head: string; passedAt: string }>;

export interface RecordIo {
	readFile: (path: string) => string | undefined;
}

export function recordPath(stateDir: string): string {
	return join(stateDir, GATE_RECORD_FILE);
}

export function parseRecord(text: string | undefined): GateRecord {
	if (text === undefined) return {};
	try {
		const value: unknown = JSON.parse(text);
		return typeof value === 'object' && value !== null && !Array.isArray(value)
			? (value as GateRecord)
			: {};
	} catch {
		return {};
	}
}
