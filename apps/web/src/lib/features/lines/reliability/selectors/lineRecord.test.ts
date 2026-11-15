import { describe, expect, it } from 'vitest';
import type { RouteReliability } from '#lib/v1/index.ts';
import { verdictForWindow } from '#lib/v1/verdict.ts';
import { withClosedPeriods } from '../__fixtures__/closedWeek';
import { selectLineRecord, type RecordMode } from './lineRecord';

/** A line file built from a small seed: one dated day row per (on time, readings) pair. */
function seedLine(end: string, days: readonly (readonly [number, number])[]): RouteReliability {
	const last = Date.parse(`${end}T00:00:00Z`);
	return withClosedPeriods({
		id: '6',
		generated_utc: '2026-11-11T06:00:00Z',
		periods: days.map(([onTime, readings], index) => ({
			grain: 'day',
			date: new Date(last - (days.length - 1 - index) * 86_400_000).toISOString().slice(0, 10),
			observation_count: readings,
			on_time: onTime,
			otp_pct: readings > 0 ? (100 * onTime) / readings : null,
			avg_delay_min: 2.5,
		})),
	} as RouteReliability);
}

function record(data: RouteReliability, mode: RecordMode, range?: { from: string; to: string }) {
	const verdict = verdictForWindow(
		data,
		{ kind: 'route', grain: mode === 'range' ? 'day' : mode, ...range },
		'en',
	);
	return selectLineRecord({ data, verdict, mode, range });
}

const WEEK = [
	[70, 100],
	[72, 100],
	[68, 100],
	[65, 100],
	[71, 100],
	[79, 100],
	[73, 100],
] as const;

describe('selectLineRecord', () => {
	it('answers the 7-day record from its own counts: 498 of 700 readings is 71%', () => {
		const result = record(seedLine('2026-11-10', WEEK), 'week');
		expect(result.period).toEqual({ from: '2026-11-04', to: '2026-11-10', days: 7 });
		expect(result.answer).toEqual({
			kind: 'figure',
			percent: 71,
			readings: 700,
			// Wilson 95% for 498/700 is 67.7% to 74.4%.
			interval: { lo: 68, hi: 74 },
			classification: 'uneven',
		});
	});

	it('answers the latest complete day and calls a range that crosses 80% uncertain', () => {
		const result = record(seedLine('2026-11-10', WEEK), 'day');
		expect(result.period).toEqual({ from: '2026-11-10', to: '2026-11-10', days: 1 });
		// 73 of 100: Wilson 63.6% to 80.7%, so the range crosses Transit's 80% reference.
		expect(result.answer).toMatchObject({
			percent: 73,
			readings: 100,
			classification: 'uncertain',
		});
	});

	it('says a thin sample is too few to judge and draws no range', () => {
		const result = record(seedLine('2026-11-10', [[9, 12]]), 'day');
		expect(result.answer).toEqual({
			kind: 'figure',
			percent: 75,
			readings: 12,
			interval: null,
			classification: 'too-few',
		});
	});

	it('keeps an unpublished reading count unknown instead of inventing one', () => {
		const data = {
			id: '6',
			generated_utc: '2026-11-11T06:00:00Z',
			periods_by_grain: [{ grain: 'day', date: '2026-11-10' }],
			periods: [{ grain: 'day', date: '2026-11-10', otp_pct: 82.4 }],
		} as RouteReliability;
		expect(record(data, 'day').answer).toEqual({
			kind: 'figure',
			percent: 82,
			readings: null,
			interval: null,
			classification: 'uncertain',
		});
	});

	it('keeps a published share and reading count when the on-time count is not published', () => {
		const data = {
			id: '6',
			generated_utc: '2026-11-11T06:00:00Z',
			periods_by_grain: [{ grain: 'day', date: '2026-11-10' }],
			periods: [{ grain: 'day', date: '2026-11-10', otp_pct: 20, observation_count: 12 }],
		} as unknown as RouteReliability;
		expect(record(data, 'day').answer).toEqual({
			kind: 'figure',
			percent: 20,
			readings: 12,
			interval: null,
			classification: 'too-few',
		});
	});

	it('reports absence, never a zero, when the period has no published figure', () => {
		const empty = {
			id: '6',
			generated_utc: '2026-11-11T06:00:00Z',
			periods: [],
		} as unknown as RouteReliability;
		expect(record(empty, 'week')).toEqual({ period: null, answer: { kind: 'absent' } });
	});

	it('withholds counts that break their own definition (on time above readings)', () => {
		const data = {
			id: '6',
			generated_utc: '2026-11-11T06:00:00Z',
			periods_by_grain: [{ grain: 'day', date: '2026-11-10' }],
			periods: [
				{ grain: 'day', date: '2026-11-10', otp_pct: 82, observation_count: 100, on_time: 150 },
			],
		} as RouteReliability;
		expect(record(data, 'day').answer).toEqual({ kind: 'absent' });
	});

	it('derives the figure from the counts when a published rate disagrees with them', () => {
		const data = {
			id: '6',
			generated_utc: '2026-11-11T06:00:00Z',
			periods_by_grain: [{ grain: 'day', date: '2026-11-10' }],
			periods: [
				{ grain: 'day', date: '2026-11-10', otp_pct: 90, observation_count: 200, on_time: 101 },
			],
		} as RouteReliability;
		// 101 / 200 = 50.5%, rounded half up to 51: below 60%, so unreliable, not uneven.
		expect(record(data, 'day').answer).toMatchObject({
			percent: 51,
			readings: 200,
			classification: 'unreliable',
		});
	});

	it('names a chosen range by its own dates, inclusive', () => {
		const data = seedLine('2026-11-10', WEEK);
		const result = record(data, 'range', { from: '2026-11-08', to: '2026-11-10' });
		expect(result.period).toEqual({ from: '2026-11-08', to: '2026-11-10', days: 3 });
		// 79 + 71 + 73 = 223 of 300 readings.
		expect(result.answer).toMatchObject({ percent: 74, readings: 300 });
	});

	it('keeps every shown share inside its definition across generated seeds', () => {
		let state = 20_261_115;
		const next = (max: number) => {
			state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
			return state % max;
		};
		for (let trial = 0; trial < 300; trial += 1) {
			const readings = 1 + next(5_000);
			const onTime = next(readings + 1);
			const result = record(seedLine('2026-11-10', [[onTime, readings]]), 'day');
			expect(result.answer.kind).toBe('figure');
			if (result.answer.kind !== 'figure') continue;
			const { percent, interval } = result.answer;
			// Exact integer rounding, half up, from the definition: on time / readings.
			expect(percent).toBe(Math.floor((200 * onTime + readings) / (2 * readings)));
			expect(Object.is(percent, -0)).toBe(false);
			expect(Number.isInteger(result.answer.readings)).toBe(true);
			if (interval) {
				expect(0 <= interval.lo && interval.lo <= percent).toBe(true);
				expect(percent <= interval.hi && interval.hi <= 100).toBe(true);
			}
		}
	});
});
