import { describe, expect, it } from 'vitest';
import { LIVE_STATUS_BANDS, type DelayBandCode } from '#lib/v1/live/statusBands.ts';
import {
	departureStatus,
	departureStatusText,
	presentStopLive,
	type StopLiveInput,
} from './stopPredictions';
import { detailCopy } from './stops.copy';

const at = (minutes: number) => new Date(Date.UTC(2026, 5, 15, 12, minutes)).toISOString();
type Seed = Omit<StopLiveInput, 'departures'> & {
	// Plain strings, as the file carries them; the schema brands them on parse.
	departures:
		| readonly {
				route?: string | null;
				trip?: string | null;
				eta_utc: string;
				delay_min?: number | null;
		  }[]
		| null;
};
const input = (overrides: Partial<Seed> = {}): StopLiveInput =>
	({
		departures: [],
		reportStale: false,
		servedLines: ['24'],
		scheduled: [],
		lineHasNoLiveData: () => false,
		lineNumber: (id: string) => id,
		order: 'soonest',
		...overrides,
	}) as StopLiveInput;

// The publisher's minute: round_half_away(seconds / 60), apps/db builders/_helpers.py `_delay_min`.
const publishedMinute = (seconds: number) =>
	Math.sign(seconds) * Math.floor(Math.abs(seconds) / 60 + 0.5) || 0;
// The exact band for the same seconds uses the published punctuality bounds.
const publishedBand = (seconds: number): DelayBandCode =>
	(Object.entries(LIVE_STATUS_BANDS) as [DelayBandCode, (typeof LIVE_STATUS_BANDS)['late']][]).find(
		([, band]) =>
			(band.fromS == null || seconds >= band.fromS) &&
			(band.belowS == null || seconds < band.belowS),
	)![0];

describe('departureStatus', () => {
	it.each([
		[-3, ['early']],
		[-2, ['early']],
		[-1, ['early', 'on_time']],
		[0, ['on_time']],
		[1, ['on_time']],
		[2, ['on_time']],
		[4, ['on_time']],
		[5, ['on_time', 'late']],
		[6, ['late']],
		[40, ['late']],
	] as const)('a rounded %i min names %j', (minute, bands) => {
		expect(departureStatus(minute)).toEqual({ kind: 'known', bands });
	});

	it.each([null, undefined, Number.NaN, Infinity, 1.5])('%s has no status', (minute) => {
		expect(departureStatus(minute)).toEqual({ kind: 'unknown' });
	});

	it('names exactly the bands the published seconds behind each minute can fall in', () => {
		// Every half second from −20 to +20 minutes, plus the ±30 s rounding edges.
		const reached = new Map<number, Set<DelayBandCode>>();
		for (let tenth = -24000; tenth <= 24000; tenth += 5) {
			const seconds = tenth / 10;
			const minute = publishedMinute(seconds);
			const status = departureStatus(minute);
			expect(status.kind).toBe('known');
			const bands = status.kind === 'known' ? status.bands : [];
			expect(bands, `${seconds} s → ${minute} min`).toContain(publishedBand(seconds));
			reached.set(minute, (reached.get(minute) ?? new Set()).add(publishedBand(seconds)));
		}
		for (const [minute, bands] of reached) {
			const status = departureStatus(minute);
			expect(status.kind === 'known' && [...status.bands].sort()).toEqual([...bands].sort());
		}
	});
});

describe('presentStopLive', () => {
	it('groups predictions by line, soonest line first, each line in time order', () => {
		const view = presentStopLive(
			input({
				servedLines: ['24', '80'],
				departures: [
					{ route: '24', trip: 'a', eta_utc: at(9), delay_min: 2 },
					{ route: '80', trip: 'b', eta_utc: at(4), delay_min: 0 },
					{ route: '24', trip: 'c', eta_utc: at(3), delay_min: null },
					{ route: '80', trip: null, eta_utc: at(12), delay_min: -2 },
				],
				scheduled: [
					{ route: '24', headsign: 'Atwater', times: [] },
					{ route: '24', headsign: 'Sherbrooke', times: [] },
					{ route: '24', headsign: 'Atwater', times: [] },
					{ route: '80', headsign: null, times: [] },
				],
			}),
		);
		expect(view.kind).toBe('list');
		if (view.kind !== 'list') return;
		expect(view.total).toBe(4);
		expect(view.groups.map((g) => [g.line, g.destinations, g.rows.map((r) => r.trip)])).toEqual([
			['24', ['Atwater', 'Sherbrooke'], ['c', 'a']],
			['80', [], ['b', null]],
		]);
		expect(view.groups[0]!.rows[0]!.status).toEqual({ kind: 'unknown' });
		expect(view.groups[1]!.rows[1]!.status).toEqual({ kind: 'known', bands: ['early'] });
	});

	it('orders lines by their number when asked, numbers before names', () => {
		const view = presentStopLive(
			input({
				order: 'line',
				departures: [
					{ route: 'r-105', eta_utc: at(1) },
					{ route: 'r-24', eta_utc: at(2) },
					{ route: 'r-9', eta_utc: at(3) },
				],
				lineNumber: (id) => id.slice(2),
			}),
		);
		expect(view.kind === 'list' && view.groups.map((g) => g.line)).toEqual([
			'r-9',
			'r-24',
			'r-105',
		]);
	});

	it('keeps a prediction whose time cannot be read, after the readable ones, with no time', () => {
		const view = presentStopLive(
			input({
				departures: [
					{ route: '24', eta_utc: 'not a time' },
					{ route: '24', eta_utc: at(5) },
				],
			}),
		);
		expect(view.kind === 'list' && view.groups[0]!.rows.map((r) => r.etaUtc)).toEqual([
			at(5),
			null,
		]);
	});

	it('groups a prediction without a line under its own unnamed group, last', () => {
		const view = presentStopLive(
			input({
				departures: [
					{ route: null, eta_utc: at(1) },
					{ route: '24', eta_utc: at(2) },
				],
			}),
		);
		expect(view.kind === 'list' && view.groups.map((g) => g.line)).toEqual(['24', null]);
	});

	it('a stop served only by lines without live data says so, never "no predictions"', () => {
		const view = presentStopLive(
			input({ servedLines: ['1', '2'], lineHasNoLiveData: (line) => line === '1' || line === '2' }),
		);
		expect(view).toEqual({ kind: 'no-capability' });
		expect(
			presentStopLive(
				input({ servedLines: ['1', '24'], lineHasNoLiveData: (line) => line === '1' }),
			).kind,
		).toBe('none');
	});

	it('shows predictions that arrive even at a stop of lines declared without live data', () => {
		const view = presentStopLive(
			input({
				lineHasNoLiveData: () => true,
				departures: [{ route: '24', eta_utc: at(1) }],
			}),
		);
		expect(view.kind).toBe('list');
	});

	it('a stop no line serves expects no predictions; an unknown line list does not claim that', () => {
		expect(presentStopLive(input({ servedLines: [] })).kind).toBe('no-service');
		expect(presentStopLive(input({ servedLines: null })).kind).toBe('none');
	});

	it('an out-of-date empty report cannot say whether predictions exist now', () => {
		expect(presentStopLive(input({ reportStale: true })).kind).toBe('stale-none');
		expect(
			presentStopLive(input({ reportStale: true, departures: [{ route: '24', eta_utc: at(1) }] }))
				.kind,
		).toBe('list');
	});

	it('has no report to present before one is loaded', () => {
		expect(presentStopLive(input({ departures: null })).kind).toBe('pending');
	});
});

describe('departureStatusText', () => {
	it.each([
		['en', -1, 'About 1 min early'],
		['en', 1, 'On time'],
		['en', 5, 'About 5 min late'],
		['fr', -1, 'Environ 1 min d’avance'],
		['fr', 1, 'À l’heure'],
		['fr', 5, 'Environ 5 min de retard'],
		['en', 0, 'On time'],
		['en', -2, 'Early'],
		['fr', 6, 'En retard'],
	] as const)('%s %i min reads "%s"', (locale, minute, words) => {
		expect(departureStatusText(minute, detailCopy[locale].live)).toBe(words);
	});

	it('names one band, or the rounded minute when the minute straddles a limit, never two bands', () => {
		const copy = detailCopy.en.live;
		const bandWords = Object.values(copy.bands);
		for (let minute = -40; minute <= 40; minute += 1) {
			const status = departureStatus(minute);
			const text = departureStatusText(minute, copy);
			if (status.kind === 'known' && status.bands.length === 1)
				expect(text, `${minute}`).toBe(copy.bands[status.bands[0]!]);
			else
				expect(text, `${minute}`).toBe(
					`About ${Math.abs(minute)} min ${minute < 0 ? 'early' : 'late'}`,
				);
			expect(bandWords.filter((word) => text?.includes(word)).length).toBeLessThanOrEqual(1);
		}
		expect(departureStatusText(null, copy)).toBeNull();
	});
});
