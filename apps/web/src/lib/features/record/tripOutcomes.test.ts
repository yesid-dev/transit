import { describe, expect, it } from 'vitest';
import {
	tripOutcomeHeaders,
	tripOutcomeLabels,
	tripOutcomeNote,
	tripsRunBase,
	tripsRunSentence,
	unconfirmedTripsRange,
} from '#lib/site/presenter.ts';
import { realTripsRun } from './tripOutcomes.fixture.ts';
import {
	sumTripOutcomes,
	tripOutcomes,
	unsettledTrips,
	type TripOutcomes,
} from './tripOutcomes.ts';

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
		// French names the agency la société de transport.
		const french = [...Object.values(tripOutcomeLabels('fr')), tripOutcomeNote('fr')].join(' ');
		expect(french).not.toMatch(/agence/u);
		expect(tripOutcomeLabels('fr').cancelled).toBe('Annulés, avec avis de la société de transport');
	});
});

// The truth pass's recount for STM, 19 to 25 November 2026: 5,343 trips never settled.
describe('the delivered-trips range', () => {
	const week = {
		counts: { scheduled: 122_410, eligible: 106_631, ran: 105_782, cancelled: 834, missing: 15 },
		excluded: { route_without_live_data: 10_436, capture_gap: 0, unconfirmed: 5343 },
	};

	it('counts the Status unknown column, capture gaps included, so the range matches the table', () => {
		expect(unsettledTrips(week)).toBe(5343);
		const gap = {
			counts: { scheduled: 1000, eligible: 800, ran: 790, cancelled: 6, missing: 4 },
			excluded: { route_without_live_data: 100, capture_gap: 60, unconfirmed: 40 },
		};
		expect(unsettledTrips(gap)).toBe(100);
		expect(tripOutcomes(gap)?.statusUnknown).toBe(100);
	});

	it('falls back to the engine count when the answer has no breakdown', () => {
		expect(unsettledTrips({ counts: { ran: 9, eligible: 10, unconfirmed: 1 } })).toBe(1);
		expect(unsettledTrips({ counts: { ran: 9, eligible: 10 }, excluded: { unconfirmed: 2 } })).toBe(
			2,
		);
		expect(unsettledTrips({ counts: { ran: 9, eligible: 10 } })).toBeNull();
	});

	it.each([
		['en', '5,343 more trips could not be confirmed, run or not: between 94.5% and 99.2% ran.'],
		[
			'fr',
			'5 343 autres trajets n’ont pas pu être confirmés, effectués ou non : entre 94,5 % et 99,2 % des trajets ont été effectués.',
		],
	] as const)('says one sentence on every screen in %s', (locale, sentence) => {
		const outcomes = tripOutcomes(week)!;
		const range = unconfirmedTripsRange(
			outcomes.ran,
			outcomes.known,
			unsettledTrips(week)!,
			locale,
		);
		expect(range && plain(range)).toBe(sentence);
	});
});
