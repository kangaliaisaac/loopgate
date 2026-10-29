import { describe, expect, it } from 'vitest';
import { resolveStateDir } from '../src/config.ts';

describe('config', () => {
	it('defaults under the home directory', () => {
		expect(resolveStateDir({}, '/h')).toBe('/h/.local/state/loopgate');
	});

	it('honours an override and ignores an empty one', () => {
		expect(resolveStateDir({ LOOPGATE_STATE_DIR: '/s' }, '/h')).toBe('/s');
		expect(resolveStateDir({ LOOPGATE_STATE_DIR: '' }, '/h')).toBe('/h/.local/state/loopgate');
	});
});
