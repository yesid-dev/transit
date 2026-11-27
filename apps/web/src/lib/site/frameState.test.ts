import { describe, expect, it } from 'vitest';
import {
	carryFrameState,
	dailyReportPeriod,
	frameHref,
	clockOnFocus,
	frameClock,
	parseAnswerFrameState,
	parseFrameState,
	periodError,
	presetPeriod,
	RECORD_START,
	recordStart,
} from './frameState.ts';

const today = '2026-11-22';
const clock = (today: string, recordThrough: string | null = null) => ({ today, recordThrough });
const url = (href: string) => new URL(href, 'https://transit.test');

describe('app frame URL state', () => {
	it('defaults to Record and the last seven complete days', () => {
		expect(parseFrameState(new URLSearchParams(), clock(today))).toEqual({
			mode: 'record',
			period: { from: '2026-11-15', to: '2026-11-21', preset: '7-days' },
		});
	});

	it('keeps the clock on a focus within the same local day, and moves it on a new day', () => {
		const toronto = { timezone: 'America/Toronto' };
		const evening = new Date('2026-11-22T03:00:00Z');
		// 22:00 and 23:59 in Toronto: the same day, so the frame is not rebuilt.
		expect(clockOnFocus(toronto, evening, new Date('2026-11-22T04:59:00Z'))).toBe(evening);
		// 00:01 the next day in Toronto: the new day moves the clock.
		const after = new Date('2026-11-22T05:01:00Z');
		expect(clockOnFocus(toronto, evening, after)).toBe(after);
	});

	it('uses the local calendar day even after UTC midnight', () => {
		expect(
			frameClock({ timezone: 'America/Los_Angeles' }, new Date('2026-11-22T06:30:00Z')).today,
		).toBe('2026-11-21');
		expect(
			frameClock({ timezone: 'America/Toronto' }, new Date('2026-11-22T06:30:00Z')).today,
		).toBe('2026-11-22');
		expect(
			frameClock({ timezone: 'America/Toronto' }, new Date('2026-11-22T02:30:00Z')).today,
		).toBe('2026-11-21');
	});

	it.each([
		['yesterday', '2026-11-21', '2026-11-21'],
		['7-days', '2026-11-15', '2026-11-21'],
		['28-days', '2026-10-25', '2026-11-21'],
		['this-month', '2026-11-01', '2026-11-22'],
		['last-month', '2026-10-13', '2026-10-31'],
		['12-months', '2026-10-13', '2026-11-21'],
	] as const)('resolves %s against calendar boundaries', (preset, from, to) => {
		expect(presetPeriod(preset, clock(today))).toEqual({ from, to, preset });
	});

	it('uses calendar months and the resolved dates remain pinned in a copied URL', () => {
		const period = presetPeriod('12-months', clock('2027-11-22'));
		expect(period).toEqual({ preset: '12-months', from: '2026-11-22', to: '2027-11-21' });
		const href = frameHref(url('/fr/lines?provider=octranspo'), { mode: 'record', period });
		expect(parseFrameState(url(href).searchParams, clock('2028-01-01')).period).toEqual(period);
		expect(url(href).searchParams.get('provider')).toBe('octranspo');
	});

	it('offers only presets that fit within the record', () => {
		expect(presetPeriod('last-month', clock('2026-10-31'))).toBeNull();
		expect(presetPeriod('7-days', clock('2026-10-15'))).toBeNull();
		expect(parseFrameState(new URLSearchParams(), clock(RECORD_START)).period).toBeNull();
	});

	it('starts a newer city’s record at its declared first day', () => {
		const city = {
			timezone: 'America/Toronto',
			record_through: '2026-11-25',
			record_from: '2026-11-25',
		};
		const newer = frameClock(city, new Date('2026-11-26T17:00:00Z'));
		expect(newer.recordStart).toBe('2026-11-25');
		expect(presetPeriod('7-days', newer)).toBeNull();
		expect(presetPeriod('12-months', newer)).toEqual({
			preset: '12-months',
			from: '2026-11-25',
			to: '2026-11-25',
		});
		expect(parseFrameState(new URLSearchParams(), newer).period).toEqual({
			preset: '12-months',
			from: '2026-11-25',
			to: '2026-11-25',
		});
		expect(periodError({ from: '2026-11-24', to: '2026-11-25' }, today, newer.recordStart)).toBe(
			'beforeRecord',
		);
	});

	it('never starts a city before the site’s record, and ignores a malformed declaration', () => {
		expect(recordStart({ record_from: '2026-01-01' })).toBe(RECORD_START);
		expect(recordStart({ record_from: '2026-11-31' })).toBe(RECORD_START);
		expect(recordStart({ record_from: null })).toBe(RECORD_START);
		expect(recordStart(null)).toBe(RECORD_START);
	});

	it.each([
		['2026-11-31', '2026-11-22', 'invalidDate'],
		['2026-11-22', '2026-11-21', 'reversed'],
		['2026-10-12', '2026-10-13', 'beforeRecord'],
		['2026-11-22', '2026-11-23', 'future'],
		[RECORD_START, today, null],
	])('validates %s through %s', (from, to, error) => {
		expect(periodError({ from, to }, today)).toBe(error);
	});

	it('ignores malformed state and preserves independently valid mode', () => {
		const params = url('/?frameMode=live&period=garbage&recordFrom=2026-10-01').searchParams;
		expect(parseFrameState(params, clock(today))).toEqual({
			mode: 'live',
			period: presetPeriod('7-days', clock(today)),
		});
	});

	it('accepts both endpoints of the public question API’s 400-day limit', () => {
		expect(periodError({ from: RECORD_START, to: '2027-11-16' }, '2027-12-01')).toBeNull();
		expect(periodError({ from: RECORD_START, to: '2027-11-17' }, '2027-12-01')).toBe('tooLong');
	});

	it('round trips custom dates and carries only frame state to a different page', () => {
		const source = url('/fr/lines?provider=octranspo&mode=rail#results');
		const frame = {
			mode: 'live',
			period: { from: RECORD_START, to: today, preset: null },
		} as const;
		const written = url(frameHref(source, frame));
		expect(parseFrameState(written.searchParams, clock('2026-12-01'))).toEqual(frame);
		expect(written.searchParams.get('mode')).toBe('rail');
		expect(written.hash).toBe('#results');
		expect(carryFrameState('/fr/search?q=95&provider=octranspo#matches', written)).toBe(
			'/fr/search?q=95&provider=octranspo&frameMode=live&recordFrom=2026-10-13&recordTo=2026-11-22#matches',
		);
	});

	it('pins a preset to its resolved dates when reopened later', () => {
		const period = presetPeriod('7-days', clock(today));
		const href = frameHref(url('/map'), { period, mode: 'record' });
		expect(parseFrameState(url(href).searchParams, clock('2026-12-01'))).toEqual({
			period,
			mode: 'record',
		});
	});

	it('marks the selected preset from exact dates when an in-app link carries only the range', () => {
		const current = clock(today);
		const period = presetPeriod('28-days', current)!;
		const source = url('/lines?recordFrom=2026-10-25&recordTo=2026-11-21');
		const link = carryFrameState('/lines/24', source);
		expect(parseFrameState(url(link).searchParams, current).period).toEqual(period);
		expect(parseFrameState(url('/lines?period=28-days').searchParams, current).period).toEqual(
			period,
		);
	});

	it('carries the selected preset with the same pinned dates and drops it for a different window', () => {
		const source = url('/lines?period=28-days&recordFrom=2026-10-25&recordTo=2026-11-21');
		const period = { from: '2026-10-25', to: '2026-11-21', preset: null };
		const same = frameHref(source, { mode: 'record', period });
		expect(url(same).searchParams.get('period')).toBe('28-days');
		const next = frameHref(source, { mode: 'record', period: { ...period, from: '2026-11-19' } });
		expect(url(next).searchParams.has('period')).toBe(false);
	});
});

it('ties record presets to the complete day but keeps Yesterday and pinned dates by the city clock', () => {
	const today = '2026-11-25';
	const through = '2026-11-23';
	expect(parseFrameState(new URLSearchParams(), clock(today, through)).period).toEqual({
		preset: '7-days',
		from: '2026-11-17',
		to: through,
	});
	expect(presetPeriod('28-days', clock(today, through))).toMatchObject({
		from: '2026-10-27',
		to: through,
	});
	expect(presetPeriod('this-month', clock(today, through))).toMatchObject({
		from: '2026-11-01',
		to: through,
	});
	expect(presetPeriod('last-month', clock(today, through))).toMatchObject({
		from: RECORD_START,
		to: '2026-10-31',
	});
	expect(presetPeriod('12-months', clock(today, through))).toMatchObject({
		from: RECORD_START,
		to: through,
	});
	expect(presetPeriod('yesterday', clock(today, through))).toMatchObject({
		from: '2026-11-24',
		to: '2026-11-24',
	});
	const pinned = new URLSearchParams({ recordFrom: '2026-11-23', recordTo: '2026-11-24' });
	expect(parseFrameState(pinned, clock(today, through)).period).toEqual({
		preset: null,
		from: '2026-11-23',
		to: '2026-11-24',
	});
});

it('waits for the first complete day of this month and caps last month at the record', () => {
	expect(presetPeriod('this-month', clock('2026-12-01', '2026-11-29'))).toBeNull();
	expect(presetPeriod('last-month', clock('2026-12-01', '2026-11-29'))).toMatchObject({
		from: '2026-11-01',
		to: '2026-11-29',
	});
});

it('answers unpublished Yesterday with the last built day while preserving the requested dates', () => {
	const params = url(
		'/lines?period=yesterday&recordFrom=2026-11-26&recordTo=2026-11-26',
	).searchParams;
	const pending = clock('2026-11-27', '2026-11-25');
	const requested = { preset: 'yesterday', from: '2026-11-26', to: '2026-11-26' };
	expect(parseFrameState(params, pending).period).toEqual(requested);
	expect(parseAnswerFrameState(params, pending).period).toEqual({
		preset: 'yesterday',
		from: '2026-11-25',
		to: '2026-11-25',
	});
	for (const through of ['2026-11-26', null]) {
		expect(parseAnswerFrameState(params, clock('2026-11-27', through)).period).toEqual(requested);
	}
});

it('opens the Daily report on one day, never a week', () => {
	const built = clock('2026-11-27', '2026-11-26');
	const week = presetPeriod('7-days', built);
	expect(dailyReportPeriod(week, built)).toEqual({
		preset: 'yesterday',
		from: '2026-11-26',
		to: '2026-11-26',
	});
	const day = { preset: null, from: '2026-11-20', to: '2026-11-20' };
	expect(dailyReportPeriod(day, built)).toEqual(day);
	// Before Yesterday is built, the report asks for Yesterday and answers with the last built day.
	const pending = clock('2026-11-27', '2026-11-25');
	const period = dailyReportPeriod(presetPeriod('28-days', pending), pending)!;
	expect(period).toEqual({ preset: 'yesterday', from: '2026-11-26', to: '2026-11-26' });
	const href = frameHref(url('/receipt'), { mode: 'record', period });
	expect(parseAnswerFrameState(url(href).searchParams, pending).period).toEqual({
		preset: 'yesterday',
		from: '2026-11-25',
		to: '2026-11-25',
	});
	expect(dailyReportPeriod(null, clock(RECORD_START))).toBeNull();
});
