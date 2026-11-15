import { createLineDirectory } from '#lib/site/lineDirectory.ts';
import { describe, it, expect } from 'vitest';
import { selectNotReportedLines, NOT_REPORTED_DOMAIN } from './notReportedLines';

const labels = {
	directory: createLineDirectory(null, { line: (id) => `Line ${id}` }),
	rowLabel: 'Line',
	href: (id: string) => `/lines/${id}`,
	fmtScheduled: (v: number | null | undefined) => (v == null ? null : `${v} scheduled`),
	hasNoLiveData: () => false,
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

	it('groups lines that publish no live data apart from lines that never appeared', () => {
		const vm = selectNotReportedLines(
			{
				notReportedRouteCount: 60,
				notReportedRoutes: [
					{ id: '1', name: 'Verte', scheduledTripDays: 900 },
					{ id: '51', name: 'Édouard-Montpetit', scheduledTripDays: 12 },
					{ id: '2', name: 'Orange', scheduledTripDays: 800 },
					{ id: '24', name: 'Sherbrooke', scheduledTripDays: 8 },
				],
			},
			{ ...labels, hasNoLiveData: (id) => id === '1' || id === '2' },
		);
		expect(vm.noLiveData.map((line) => [line.title, line.href])).toEqual([
			['Verte', '/lines/1'],
			['Orange', '/lines/2'],
		]);
		expect(vm.rows.map((row) => [row.key, row.rank])).toEqual([
			['51', 1],
			['24', 2],
		]);
		expect([vm.shown, vm.total, vm.hasData]).toEqual([2, 58, true]);
		// Parts sum to their totals; nothing negative.
		expect(vm.shown + vm.noLiveData.length).toBe(4);
		expect(vm.total! + vm.noLiveData.length).toBe(60);
	});

	it('still has data when every listed line publishes no live data', () => {
		const vm = selectNotReportedLines(
			{
				notReportedRouteCount: 1,
				notReportedRoutes: [{ id: '1', name: 'Verte', scheduledTripDays: 900 }],
			},
			{ ...labels, hasNoLiveData: () => true },
		);
		expect([vm.rows.length, vm.noLiveData.length, vm.shown, vm.total, vm.hasData]).toEqual([
			0,
			1,
			0,
			0,
			true,
		]);
		const unknownTotal = selectNotReportedLines(
			{ notReportedRoutes: [{ id: '1', name: null, scheduledTripDays: null }] },
			{ ...labels, hasNoLiveData: () => true },
		);
		expect(unknownTotal.total).toBeNull();
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
