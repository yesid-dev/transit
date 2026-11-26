import { describe, expect, it } from 'vitest';
import { tripOutcomeHeaders, tripsRunBase, tripsRunSentence } from '#lib/site/presenter.ts';
import { realTripsRun } from './tripOutcomes.fixture.ts';
import { sumTripOutcomes, tripOutcomes, type TripOutcomes } from './tripOutcomes.ts';

type Row = readonly [number, number, number, number, number, number];
function evidence([scheduled, eligible, ran, cancelled, missing, noLive]: Row) {
	return {
		counts: { scheduled, eligible, ran, cancelled, missing },
		excluded: { route_without_live_data: noLive },
	};
}
const plain = (text: string) => text.replace(/\s/g, ' ');
const adds = (row: TripOutcomes) =>
	row.noLiveData + row.statusUnknown + row.ran + row.cancelled + row.missing;

describe('trip outcomes on real engine answers', () => {
	for (const [cut, data] of Object.entries(realTripsRun)) {
		it(`${cut}: every row adds up and the days add up to the period`, () => {
			const period = tripOutcomes(evidence(data.period))!;
			expect(period).not.toBeNull();
			expect(adds(period)).toBe(period.scheduled);
			expect(period.ran + period.cancelled + period.missing).toBe(period.known);
			// The published rate is ran over the known-status trips, never over scheduled.
			expect(period.ran / period.known).toBeCloseTo(data.rate, 12);
			const days = data.days.map(([, ...row]) => tripOutcomes(evidence(row as Row))!);
			for (const day of days) expect(adds(day)).toBe(day.scheduled);
			expect(sumTripOutcomes(days)).toEqual(period);
		});
	}

	it('names the gap the review found on STM, 18 to 24 November', () => {
		const day = tripOutcomes(evidence(realTripsRun['stm-7'].days[0].slice(1) as unknown as Row))!;
		// 19,141 scheduled = 1,654 no live data + 764 status unknown + 16,595 + 125 + 3.
		expect(day).toEqual({
			scheduled: 19_141,
			noLiveData: 1_654,
			statusUnknown: 764,
			known: 16_723,
			ran: 16_595,
			cancelled: 125,
			missing: 3,
		});
	});

	it('refuses a breakdown that cannot add up', () => {
		expect(
			tripOutcomes({ counts: { scheduled: 10, eligible: 12, ran: 12, cancelled: 0, missing: 0 } }),
		).toBeNull();
		expect(
			tripOutcomes({ counts: { scheduled: 10, eligible: 8, ran: 7, cancelled: 0, missing: 0 } }),
		).toBeNull();
		expect(
			tripOutcomes({ counts: { scheduled: null, eligible: 8, ran: 8, cancelled: 0, missing: 0 } }),
		).toBeNull();
	});

	it('names the base of the rate in both languages', () => {
		expect(tripsRunSentence(106_816, 'en')).toBe('of the 106,816 trips with a known status ran');
		expect(plain(tripsRunSentence(106_816, 'fr'))).toBe(
			'des 106 816 trajets à l’état connu ont été effectués',
		);
		expect(tripsRunBase(105_961, 106_816, 'en')).toBe(
			'105,961 of the 106,816 trips with a known status',
		);
		expect(plain(tripsRunBase(105_961, 106_816, 'fr'))).toBe(
			'105 961 des 106 816 trajets à l’état connu',
		);
		expect(Object.values(tripOutcomeHeaders('fr'))).not.toContain('Unknown');
	});
});
