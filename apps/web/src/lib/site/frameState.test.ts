import { describe, expect, it } from 'vitest';
import {
	carryFrameState,
	frameHref,
	frameToday,
	parseFrameState,
	periodError,
	presetPeriod,
	RECORD_START,
} from './frameState.ts';

const today = '2026-11-22';
const url = (href: string) => new URL(href, 'https://transit.test');

describe('app frame URL state', () => {
	it('defaults to Record and the last seven complete days', () => {
		expect(parseFrameState(new URLSearchParams(), today)).toEqual({
			mode: 'record',
			period: { from: '2026-11-15', to: '2026-11-21', preset: '7-days' },
		});
	});

	it('uses the local calendar day even after UTC midnight', () => {
		expect(frameToday('America/Los_Angeles', new Date('2026-11-22T06:30:00Z'))).toBe('2026-11-21');
		expect(frameToday('America/Toronto', new Date('2026-11-22T06:30:00Z'))).toBe('2026-11-22');
		expect(frameToday('America/Toronto', new Date('2026-11-22T02:30:00Z'))).toBe('2026-11-21');
	});

	it.each([
		['yesterday', '2026-11-21', '2026-11-21'],
		['7-days', '2026-11-15', '2026-11-21'],
		['28-days', '2026-10-25', '2026-11-21'],
		['this-month', '2026-11-01', '2026-11-22'],
		['last-month', '2026-10-13', '2026-10-31'],
	] as const)('resolves %s against calendar boundaries', (preset, from, to) => {
		expect(presetPeriod(preset, today)).toEqual({ from, to, preset });
	});

	it('offers only presets that fit within the record', () => {
		expect(presetPeriod('last-month', '2026-10-31')).toBeNull();
		expect(presetPeriod('7-days', '2026-10-15')).toBeNull();
		expect(parseFrameState(new URLSearchParams(), RECORD_START).period).toBeNull();
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
		expect(parseFrameState(params, today)).toEqual({
			mode: 'live',
			period: presetPeriod('7-days', today),
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
		expect(parseFrameState(written.searchParams, '2026-12-01')).toEqual(frame);
		expect(written.searchParams.get('mode')).toBe('rail');
		expect(written.hash).toBe('#results');
		expect(carryFrameState('/fr/search?q=95&provider=octranspo#matches', written)).toBe(
			'/fr/search?q=95&provider=octranspo&frameMode=live&recordFrom=2026-10-13&recordTo=2026-11-22#matches',
		);
	});

	it('pins a preset to its resolved dates when reopened later', () => {
		const period = presetPeriod('7-days', today);
		const href = frameHref(url('/map'), { period, mode: 'record' });
		expect(parseFrameState(url(href).searchParams, '2026-12-01')).toEqual({
			period,
			mode: 'record',
		});
	});
});
