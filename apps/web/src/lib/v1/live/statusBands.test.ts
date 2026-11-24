import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { StatusCodeSchema } from '../schemas/types';
import { classifyDelay, ON_TIME_LIMITS_S } from './statusBands';

it.each([
	[-61, 'early'],
	[-60, 'on_time'],
	[300, 'on_time'],
	[300.5, 'late'],
	[301, 'late'],
	[null, 'unknown'],
] as const)('classifies %s seconds as %s', (delay, expected) => {
	expect(classifyDelay(delay)).toBe(expected);
});

it('keeps Severe in the published schema and out of Live classifications', () => {
	expect(StatusCodeSchema.parse('severe')).toBe('severe');
	expect(new Set([-61, -60, 300, 301, 3_600, null].map(classifyDelay))).toEqual(
		new Set(['early', 'on_time', 'late', 'unknown']),
	);
});

it('matches the bounds used by the engine registry on How we measure', () => {
	const registry = readFileSync(
		new URL('../../../../../engine/src/transit_engine/measures.py', import.meta.url),
		'utf8',
	);
	expect(registry.split(/\r?\n/)).toContain('EARLY_LIMIT_SECONDS = ' + ON_TIME_LIMITS_S.from);
	expect(registry.split(/\r?\n/)).toContain('LATE_LIMIT_SECONDS = ' + ON_TIME_LIMITS_S.through);
	expect(registry).toContain('method_version="punctuality-v3"');
	expect(registry).toContain('seconds late, including both limits.');
	expect(registry).toContain(
		'delay_seconds BETWEEN {EARLY_LIMIT_SECONDS} AND {LATE_LIMIT_SECONDS}',
	);
});
