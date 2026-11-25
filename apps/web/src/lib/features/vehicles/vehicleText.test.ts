import { expect, it } from 'vitest';
import type { RecordMeasure, RecordSeries } from '#lib/server/engine.ts';
import {
	assignmentCaution,
	notTracked,
	vehicleHeadline,
	vehicleRecordState,
	vehicleReading,
	vehicleReportDays,
	vehicleServiceDays,
} from './vehicleText.ts';

it('leads with the published status even when the numerical offset is behind schedule', () => {
	const vehicle = { status: 'on_time', delay_min: 4 } as const;
	expect(vehicleHeadline(vehicle, 'en')).toBe('On time, 4 min behind the timetable');
	expect(vehicleHeadline(vehicle, 'fr')).toBe('À l’heure, 4 min après l’heure prévue');
	expect(vehicleHeadline({ status: 'late', delay_min: null }, 'en')).toBe('Late');
});

it.each([
	['not_measured', 'Non mesuré'],
	['too_few_to_judge', 'Trop peu pour juger'],
	['unknown', 'Inconnu'],
])('keeps the engine’s %s explanation', (state, text) => {
	expect(vehicleRecordState(state, text, 'fr')).toBe(text);
});

it('explains the tracking limit and the influence of assignments in both languages', () => {
	expect(vehicleRecordState('not_tracked', '', 'en')).toContain('stable vehicle numbers');
	expect(notTracked.fr).toContain('numéros de véhicule stables');
	expect(assignmentCaution.en).toContain('lines and hours it is assigned to');
	expect(assignmentCaution.fr).toContain('lignes et les heures qu’on lui confie');
});

const period = { from: '2026-11-08', to: '2026-11-11' };
const evidence = {
	start_date: period.from,
	end_date: period.to,
	days_included: ['2026-11-08', '2026-11-09'],
	days_measured: ['2026-11-08', '2026-11-09'],
	days_not_measured: ['2026-11-10', '2026-11-11'],
	method_version: 'fixture',
	cleaning_versions: [8],
	query_ms: 1,
};
const measures: RecordMeasure = {
	state: 'measured',
	state_text: { en: 'Measured', fr: 'Mesuré' },
	value: { vehicle_days_in_service: 1, vehicle_reporting_gaps_per_100_hours: 130.76 },
	evidence: { ...evidence, counts: {} },
	coverage_note: null,
};

function dailyCell(
	day: string,
	active: number,
	state: 'measured' | 'not_measured' = 'measured',
): RecordSeries['cells'][number] {
	return {
		key: { day },
		state,
		state_text: measures.state_text,
		value: { vehicle_days_in_service: active, vehicle_hours_in_service: active ? 2.5 : 0 },
		evidence: { counts: {}, days_included: state === 'measured' ? [day] : [] },
	};
}

it.each([
	['en', '1 of 2', '2.5', 'Did not report', '130.8'],
	['fr', '1 sur 2', '2,5', 'Aucun signalement', '130,8'],
] as const)(
	'uses measured dates and distinguishes unmeasured days in %s',
	(locale, ratio, hours, noReport, rate) => {
		expect(vehicleServiceDays(measures, locale)).toEqual({ ratio, total: 2, partial: true });
		expect(vehicleReading(measures, 'vehicle_reporting_gaps_per_100_hours', locale)).toBe(rate);
		const days = vehicleReportDays(
			{
				evidence,
				coverage_note: null,
				cells: [
					dailyCell('2026-11-08', 1),
					dailyCell('2026-11-09', 0),
					dailyCell('2026-11-10', 0, 'not_measured'),
				],
			},
			period,
			locale,
		);
		expect(days.map(({ state }) => state)).toEqual([
			'in_service',
			'not_reporting',
			'not_measured',
			'not_measured',
		]);
		expect(days[0].report).toEqual({ value: hours + ' h', fraction: 1 });
		expect(days[1]).toMatchObject({
			dateLabel: expect.stringContaining(noReport),
			report: { value: '◇', fraction: 0 },
		});
		expect(days.slice(2).map(({ report }) => report)).toEqual([null, null]);
		expect(days.slice(2).every(({ dateLabel }) => !dateLabel.includes(noReport))).toBe(true);
	},
);
