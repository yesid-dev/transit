import { describe, expect, it } from 'vitest';
import { STATUS_CODES } from '#lib/v1/schemas/types.ts';
import { STATUS_GLYPH } from './tokens';

describe('STATUS_GLYPH', () => {
	it('gives every status its own shape, so none relies on colour alone', () => {
		const shapes = STATUS_CODES.map((code) => STATUS_GLYPH[code]);
		expect(new Set(shapes).size).toBe(STATUS_CODES.length);
	});
});
