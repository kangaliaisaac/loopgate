import { readFileSync } from 'node:fs';

/** A file's text, or undefined when it cannot be read. */
export function readTextFile(path: string): string | undefined {
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return undefined;
	}
}
