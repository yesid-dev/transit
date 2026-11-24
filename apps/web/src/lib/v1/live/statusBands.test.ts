import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { classifyDelay, LIVE_STATUS_BANDS } from './statusBands';

it.each([
	[-61, 'early'],
	[-60, 'on_time'],
	[-59, 'on_time'],
	[299, 'on_time'],
	[300, 'late'],
	[null, 'unknown'],
] as const)('classifies %s seconds as %s', (delay, expected) => {
	expect(classifyDelay(delay)).toBe(expected);
});

it('matches the bounds used by the engine registry on How we measure', () => {
	const registry = readFileSync(
		new URL('../../../../../engine/src/transit_engine/measures.py', import.meta.url),
		'utf8',
	);
	const { fromS, belowS } = LIVE_STATUS_BANDS.on_time;
	expect(registry.split(/\r?\n/)).toContain('EARLY_LIMIT_SECONDS = ' + fromS);
	expect(registry.split(/\r?\n/)).toContain('LATE_LIMIT_SECONDS = ' + belowS);
	expect(registry).toContain('seconds early (inclusive) to ');
	expect(registry).toContain('seconds late (exclusive).');
});
