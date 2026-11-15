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

	const isRail = (id: string) => id.startsWith('rail');
	const route = (id: string, scheduledTripDays = 10) => ({ id, name: id, scheduledTripDays });
	const partition = (count: number | null, ids: string[]) => {
		const vm = selectNotReportedLines(
			{ notReportedRouteCount: count, notReportedRoutes: ids.map((id) => route(id)) },
			{ ...labels, hasNoLiveData: isRail },
		);
		return [vm.rows.length, vm.noLiveData.length, vm.hidden, vm.total];
	};
	// Owner ruling 6: listed ordinary + listed no-live-data + hidden = the published total.
	const sumsToTotal = ([rows, noLive, hidden, total]: (number | null)[]) =>
		[rows, noLive, hidden].every((n) => n != null && n >= 0) && rows! + noLive! + hidden! === total;

	it('keeps lines beyond the published list unclassified', () => {
		const buses = Array.from({ length: 50 }, (_, i) => `bus${i}`);
		expect(partition(51, buses)).toEqual([50, 0, 1, 51]);
		expect(partition(60, ['rail1', 'bus1', 'rail2', 'bus2'])).toEqual([2, 2, 56, 60]);
		expect(partition(3, ['rail1'])).toEqual([0, 1, 2, 3]);
		expect(partition(2, ['rail1', 'bus1'])).toEqual([1, 1, 0, 2]);
		for (const parts of [
			partition(51, buses),
			partition(60, ['rail1', 'bus1', 'rail2', 'bus2']),
			partition(3, ['rail1']),
			partition(2, ['rail1', 'bus1']),
		]) {
			expect(sumsToTotal(parts)).toBe(true);
		}
	});

	it('leaves the hidden count unknown when the total is missing or smaller than the list', () => {
		expect(partition(null, ['rail1', 'bus1'])).toEqual([1, 1, null, null]);
		expect(partition(1, ['rail1', 'bus1'])).toEqual([1, 1, null, 1]);
	});

	it('groups lines that publish no live data apart from lines that never appeared', () => {
		const vm = selectNotReportedLines(
			{
				notReportedRouteCount: 4,
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
		expect(vm.hasData).toBe(true);
		expect(
			selectNotReportedLines(
				{ notReportedRouteCount: 1, notReportedRoutes: [route('rail1')] },
				{ ...labels, hasNoLiveData: isRail },
			).hasData,
		).toBe(true);
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
