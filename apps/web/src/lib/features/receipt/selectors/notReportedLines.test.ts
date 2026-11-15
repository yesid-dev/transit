import { createLineDirectory } from '#lib/site/lineDirectory.ts';
import { describe, it, expect } from 'vitest';
import { selectNotReportedLines, NOT_REPORTED_DOMAIN } from './notReportedLines';

const labels = {
	directory: createLineDirectory(null, { line: (id) => `Line ${id}` }),
	rowLabel: 'Line',
	href: (id: string) => `/lines/${id}`,
	fmtScheduled: (v: number | null | undefined) => (v == null ? null : `${v} scheduled`),
};

describe('selectNotReportedLines', () => {
	it('builds ranked rows linking to /lines/[id] on the fixed count domain', () => {
		const vm = selectNotReportedLines(
			{
				notReportedRouteCount: 3,
				notReportedRoutes: [
					{ id: '51', name: 'Édouard-Montpetit', scheduledTripDays: 12 },
					{ id: '24', name: 'Sherbrooke', scheduledTripDays: 8 },
				],
			},
			labels,
		);
		expect(vm.hasData).toBe(true);
		expect(vm.rows[0].href).toBe('/lines/51');
		expect(vm.rows[0].title).toBe('Édouard-Montpetit');
		expect(vm.rows[0].domain).toBe(NOT_REPORTED_DOMAIN);
		expect(vm.rows[0].severity).toBe('critical');
		expect(vm.rows[0].display).toBe('12 scheduled');
	});

	it('carries the shown/total honesty (pre-cap count vs capped list)', () => {
		const vm = selectNotReportedLines(
			{
				notReportedRouteCount: 200,
				notReportedRoutes: [{ id: '1', name: null, scheduledTripDays: 5 }],
			},
			labels,
		);
		expect(vm.shown).toBe(1);
		expect(vm.total).toBe(200);
	});

	it('stands down on ramp-in — an ABSENT list is honest-absence, not an empty "all reported"', () => {
		expect(selectNotReportedLines(undefined, labels).hasData).toBe(false);
		expect(selectNotReportedLines({ notReportedRoutes: [] }, labels).hasData).toBe(false);
	});
});
it('ladder rows lead with the line number', () => {
	const directory = createLineDirectory(
		[{ id: '1-373', short: '1', long: 'Confederation', type: 1 }],
		{ line: (id) => `Line ${id}` },
	);
	const result = selectNotReportedLines(
		{ notReportedRoutes: [{ id: '1-373', name: 'Confederation', scheduledTripDays: null }] },
		{ ...labels, directory },
	);
	expect(result.rows[0].title).toBe('1 · Confederation');
	expect(result.rows[0].ariaLabel).toBeUndefined();
});
