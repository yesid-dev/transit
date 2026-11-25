import { describe, expect, it } from 'vitest';
import type { RecordSeries } from '#lib/server/engine.ts';
import { dailyPeriods, departureDays } from './departureDailyText.ts';
import { departureFromKey, departureHref } from './departureIdentity.ts';

const evidence = {
	start_date: '2026-11-18',
	end_date: '2026-11-20',
	days_included: ['2026-11-18', '2026-11-20'],
	days_measured: ['2026-11-18', '2026-11-20'],
	days_not_measured: ['2026-11-19'],
	method_version: 'fixture',
	cleaning_versions: [8],
	query_ms: 4,
};
function cell(
	key: Record<string, string | number>,
	classified: number,
	late: number,
	scheduled = classified,
	withoutLiveData = 0,
) {
	return {
		key,
		state: 'too_few_to_judge' as const,
		state_text: { en: 'Too few to judge', fr: 'Trop peu pour juger' },
		value: { late: null },
		evidence: {
			counts: { classified, late, scheduled },
			excluded: { route_without_live_data: withoutLiveData },
			days_included: ['2026-11-18'],
		},
	};
}
function series(cells: RecordSeries['cells']): RecordSeries {
	return { evidence, cells, coverage_note: null, info: [{ minimum_sample: 30 }] };
}

describe('Departure and Daily report text', () => {
	it('counts observed and late days using the original counts even when a daily rate is suppressed', () => {
		expect(
			departureDays(
				series([
					cell({ day: '2026-11-18' }, 6, 1),
					{ ...cell({ day: '2026-11-19' }, 2, 2), state: 'not_measured' },
					cell({ day: '2026-11-20' }, 8, 0),
				]),
			),
		).toEqual({ observed: 2, late: 1 });
	});

	it('sums numerators and denominators across the midnight boundary and applies the pooled floor', () => {
		const rows = dailyPeriods(
			series([
				cell({ hour: 19 }, 20, 1),
				cell({ hour: 0 }, 20, 7),
				cell({ hour: 4 }, 10, 2),
				cell({ hour: 5 }, 20, 19),
			]),
			'en',
		);
		expect(rows).toHaveLength(5);
		expect(rows[4]).toMatchObject({ hours: '19:00 to 05:00', value: '20.0%', count: '50' });
		expect(rows[0]).toMatchObject({
			state: 'too_few_to_judge',
			detail: '20 stop events (minimum 30)',
			value: null,
		});
	});

	it('pools live-eligible scheduled stops at the coverage boundary', () => {
		const answer: RecordSeries = {
			...series([
				cell({ hour: 5 }, 20, 5, 80, 20),
				cell({ hour: 6 }, 20, 5, 81, 20),
				cell({ hour: 7 }, 20, 5, 80, 20),
				cell({ hour: 8 }, 20, 5, 80, 20),
				{
					...cell({ hour: 10 }, 0, 0, 0, 20),
					state: 'no_live_data',
					state_text: { en: 'No live data', fr: 'Aucune donnée en direct' },
				},
			]),
			info: [{ minimum_sample: 30, minimum_coverage: 0.25, low_coverage_below: 0.5 }],
		};
		const rows = dailyPeriods(answer, 'fr');
		expect(rows[0]).toMatchObject({
			state: 'not_measured',
			detail: 'Couverture insuffisante',
			count: '40',
		});
		expect(rows[1]).toMatchObject({
			state: null,
			value: expect.stringMatching(/^25,0\s%$/u),
			count: '40',
		});
		expect(rows[2]).toMatchObject({ state: 'no_live_data', count: null });
	});

	it('round-trips a provider-supplied line key and after-midnight service time', () => {
		const source = new URL(
			'https://transit.test/fr/lines?frameMode=live&recordFrom=2026-11-18&recordTo=2026-11-20',
		);
		const href = departureHref(source, 'fr', 'demo', '36 / é', 0, '25:42:00');
		expect(href).toContain('/fr/departure/');
		const target = new URL(href!, source);
		const key = decodeURIComponent(target.pathname.split('/').at(-1)!);
		expect(departureFromKey(key)).toEqual({ line: '36 / é', direction: 0, departure: '25:42:00' });
		expect(target.searchParams.get('frameMode')).toBe('record');
		expect(target.searchParams.get('recordFrom')).toBe('2026-11-18');
		expect(departureHref(source, 'en', 'demo', '36', null, '07:42:00')).toBeNull();
	});
});
