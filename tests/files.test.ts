import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readTextFile } from '../src/gates/files.ts';

describe('readTextFile', () => {
	it('reads a file and returns undefined for one that is missing', () => {
		const dir = mkdtempSync(join(tmpdir(), 'files-'));
		writeFileSync(join(dir, 'a.txt'), 'hello');
		expect(readTextFile(join(dir, 'a.txt'))).toBe('hello');
		expect(readTextFile(join(dir, 'missing.txt'))).toBeUndefined();
	});
});
