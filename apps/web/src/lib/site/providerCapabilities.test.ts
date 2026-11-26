import { expect, it } from 'vitest';
import { hasScheduleOnlyLines } from './providerCapabilities.ts';

it('keeps the rail key only for a city that declares lines without live data', () => {
	const gap = (route_types: number[], route_ids: string[] = []) => ({
		lines_without_live_data: [{ route_types, route_ids }],
	});
	expect(hasScheduleOnlyLines(gap([1]))).toBe(true);
	expect(hasScheduleOnlyLines(gap([], ['R1']))).toBe(true);
	expect(hasScheduleOnlyLines({ lines_without_live_data: [] })).toBe(false);
	expect(hasScheduleOnlyLines(gap([]))).toBe(false);
	expect(hasScheduleOnlyLines(null)).toBe(true);
});
