import { describe, expect, it } from 'vitest';
import { delayTone } from './delayPresentation';

describe('delayTone', () => {
	it('bands a delay to a calm-by-default status tone', () => {
		expect(delayTone(null)).toBe('none');
		expect(delayTone(undefined)).toBe('none');
		expect(delayTone(-3)).toBe('early');
		expect(delayTone(0)).toBe('on-time');
		expect(delayTone(2)).toBe('late');
		expect(delayTone(8)).toBe('severe');
	});
});
