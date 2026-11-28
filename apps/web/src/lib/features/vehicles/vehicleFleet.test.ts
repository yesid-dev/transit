import { expect, it } from 'vitest';
import type { RecordSeries } from '#lib/server/engine.ts';
import { fleetView, projectVehicleFleet } from './vehicleFleet.ts';

const date = '2026-11-04';
const evidence = {
	start_date: date,
	end_date: date,
	days_included: [date],
	days_measured: [date],
	days_not_measured: [],
	cleaning_versions: [8],
	method_version: 'test',
	query_ms: 1,
};
const source: RecordSeries = {
	evidence,
	coverage_note: null,
	cells: Array.from({ length: 25 }, (_, index) => ({
		key: { vehicle: `49-${index + 1}` },
		state: 'measured',
		state_text: { en: 'Measured', fr: 'Mesuré' },
		value: { vehicle_days_in_service: index === 0 ? 0 : 1 },
		evidence: {
			days_included: [date],
			counts: { hours_in_service: index === 0 ? 0 : 3, lines_run: 2, trips_run: 4 },
		},
	})),
};

it.each(['en', 'fr'] as const)(
	'maps the first page and avoids false zero readings in %s',
	(locale) => {
		const first = projectVehicleFleet(source, fleetView(new URLSearchParams()), locale);
		expect(first.rows).toHaveLength(20);
		expect(first.total).toBe(25);
		expect(first.active).toBe(24);
		expect(first.reportingCounts).toEqual({ reported: 24, didNotReport: 1, unmeasured: 0 });
		expect(first.rows[0]).toEqual({
			id: '49-1',
			state: 'not_reporting',
			days: null,
			hours: null,
			lines: null,
			trips: null,
		});
		expect(first.rows[1]).toMatchObject({ id: '49-2', days: 1, hours: 3, lines: 2, trips: 4 });
		const silent = projectVehicleFleet(
			source,
			fleetView(new URLSearchParams('reporting=silent')),
			locale,
		);
		expect(silent.rows.map(({ id }) => id)).toEqual(['49-1']);
		expect(silent.fleet).toBe(25);
		expect(silent.reportingCounts).toEqual({ reported: 0, didNotReport: 1, unmeasured: 0 });
	},
);

it('keeps an unmeasured vehicle apart from one known not to have reported', () => {
	const answer: RecordSeries = {
		...source,
		cells: [
			...source.cells,
			{ ...source.cells[0]!, key: { vehicle: '49-26' }, state: 'not_measured' },
		],
	};
	const reading = projectVehicleFleet(answer, fleetView(new URLSearchParams('q=49-26')), 'en');
	expect(reading.reportingCounts).toEqual({ reported: 0, didNotReport: 0, unmeasured: 1 });
});
