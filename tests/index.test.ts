import { describe, expect, it } from 'vitest';
import * as library from '../src/index.ts';

describe('library surface', () => {
	it('exports exactly what other packages may depend on', () => {
		expect(Object.keys(library).sort()).toEqual([
			'GitUnavailable',
			'gatesBlock',
			'remoteName',
			'repoState',
			'spawnExec',
			'stdoutOf',
			'withBudget'
		]);
	});
});
