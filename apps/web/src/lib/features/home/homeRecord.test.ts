import { describe, expect, it } from 'vitest';
import type { HistoricAvailabilityIndex, NetworkTrend } from '#lib/v1/index.ts';
import { formatWeek, latestCompleteWeek, type HomeRecord } from './homeRecord';

type Week = { date: string; otp_pct?: number | null; observation_count?: number | null };

function trend(weekly: readonly Week[]): NetworkTrend {
	return { generated_utc: '2026-11-11T00:00:00Z', weekly } as NetworkTrend;
}

function availability(
	network: { first?: string | null; last?: string | null; gaps?: [string, string][] } | null,
): HistoricAvailabilityIndex {
	return {
		families: network
			? [
					{
						family: 'network',
						selection_mode: 'range',
						index_path: 'historic/history/network/index.json',
						first_available_date: network.first ?? null,
						last_available_date: network.last ?? null,
						gaps: (network.gaps ?? []).map(([start_date, end_date]) => ({ start_date, end_date })),
					},
				]
			: [],
	} as unknown as HistoricAvailabilityIndex;
}

// https://data.yesid.dev/v1/octranspo/historic/network_trend.json and history/index.json, both
// published 2026-11-11: collection began Friday October 2 and is closed through November 10.
const ottawaWeeks: Week[] = [
	{ date: '2026-09-28', otp_pct: 74, observation_count: 3_120_000 },
	{ date: '2026-10-05', otp_pct: 75, observation_count: 7_155_092 },
	{ date: '2026-10-12', otp_pct: 77, observation_count: 6_843_007 },
	{ date: '2026-10-19', otp_pct: 76, observation_count: 6_949_942 },
	{ date: '2026-10-26', otp_pct: 76, observation_count: 6_741_817 },
	{ date: '2026-11-02', otp_pct: 75, observation_count: 6_910_589 },
	{ date: '2026-11-09', otp_pct: 79, observation_count: 2_476_953 },
];
const ottawaIndex = availability({ first: '2026-10-02', last: '2026-11-10' });

describe('a week in words', () => {
	it.each([
		['2026-11-02', '2026-11-08', 'November 2 to 8', '2 au 8 novembre'],
		['2026-10-26', '2026-11-01', 'October 26 to November 1', '26 octobre au 1er novembre'],
		[
			'2026-12-28',
			'2027-01-03',
			'December 28, 2026 to January 3, 2027',
			'28 décembre 2026 au 3 janvier 2027',
		],
	])('names %s to %s with its own dates', (from, to, en, fr) => {
		expect(formatWeek({ from, to }, 'en')).toBe(en);
		expect(formatWeek({ from, to }, 'fr')).toBe(fr);
	});
});

describe('the latest complete record', () => {
	it('reads Ottawa’s published files of November 11 as the week of November 2 to 8', () => {
		expect(latestCompleteWeek(trend(ottawaWeeks), ottawaIndex)).toEqual({
			kind: 'week',
			week: { from: '2026-11-02', to: '2026-11-08' },
			onTimePct: 75,
			readings: 6_910_589,
			previous: { week: { from: '2026-10-26', to: '2026-11-01' }, onTimePct: 76 },
		});
	});

	it('never takes the open week or one that began before collection, in any order', () => {
		const shuffled = [ottawaWeeks[6], ottawaWeeks[0], ottawaWeeks[5], ottawaWeeks[4]];
		const record = latestCompleteWeek(trend(shuffled), ottawaIndex);
		expect(record.kind === 'week' && record.week.from).toBe('2026-11-02');
		const onlyOpenAndPartial = latestCompleteWeek(
			trend([ottawaWeeks[0], ottawaWeeks[6]]),
			ottawaIndex,
		);
		expect(onlyOpenAndPartial).toEqual({ kind: 'none' });
	});

	it('skips a week the record has a gap in', () => {
		const record = latestCompleteWeek(
			trend(ottawaWeeks),
			availability({
				first: '2026-10-02',
				last: '2026-11-10',
				gaps: [['2026-11-05', '2026-11-05']],
			}),
		);
		expect(record.kind === 'week' && record.week).toEqual({ from: '2026-10-26', to: '2026-11-01' });
	});

	it.each([
		['no history index', null],
		['no network family', availability(null)],
		['no closed day', availability({ first: '2026-10-02', last: null })],
		['no first day', availability({ first: null, last: '2026-11-10' })],
	])('says nothing is complete when the record cannot show it: %s', (_case, index) => {
		expect(latestCompleteWeek(trend(ottawaWeeks), index)).toEqual({ kind: 'none' });
		expect(latestCompleteWeek(null, ottawaIndex)).toEqual({ kind: 'none' });
	});

	it.each([
		[29, 'thin', 29],
		[0, 'thin', 0],
		[null, 'unpublished', null],
		[-5, 'unpublished', null],
		[1.5, 'unpublished', null],
	] as const)(
		'holds the figure back when its readings are %s, never a reassuring figure',
		(readings, reason, shown) => {
			const weeks = [{ date: '2026-11-02', otp_pct: 100, observation_count: readings }];
			expect(latestCompleteWeek(trend(weeks), ottawaIndex)).toEqual({
				kind: 'held',
				reason,
				week: { from: '2026-11-02', to: '2026-11-08' },
				readings: shown,
			});
		},
	);

	it.each([null, -1, 101, Number.NaN])('holds back an on-time share of %s', (otp) => {
		const weeks = [{ date: '2026-11-02', otp_pct: otp, observation_count: 5_000 }];
		expect(latestCompleteWeek(trend(weeks), ottawaIndex)).toMatchObject({
			kind: 'held',
			reason: 'unpublished',
			readings: 5_000,
		});
	});

	it.each([
		['missing', [ottawaWeeks[3], ottawaWeeks[5]]],
		['below the reading floor', [{ ...ottawaWeeks[4], observation_count: 29 }, ottawaWeeks[5]]],
		['not published', [{ ...ottawaWeeks[4], otp_pct: null }, ottawaWeeks[5]]],
	])('names no week before when the one before is %s', (_case, weeks) => {
		const record = latestCompleteWeek(trend(weeks), ottawaIndex);
		expect(record.kind === 'week' && record.previous).toBeNull();
	});

	it('keeps every figure inside its definition for 1,000 seeded records', () => {
		let state = 20261115;
		const random = () => {
			state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
			return state / 2_147_483_648;
		};
		const day = (key: string, shift: number) => {
			const date = new Date(`${key}T00:00:00Z`);
			date.setUTCDate(date.getUTCDate() + shift);
			return date.toISOString().slice(0, 10);
		};
		const broken: string[] = [];
		const kinds = new Set<HomeRecord['kind']>();
		for (let n = 0; n < 1_000; n++) {
			const first = day('2026-06-01', Math.floor(random() * 120));
			const last = day(first, Math.floor(random() * 90) - 5);
			const weeks: Week[] = Array.from({ length: Math.floor(random() * 25) }, (_, i) => ({
				date: day('2026-05-25', 7 * i),
				otp_pct: random() < 0.1 ? null : Math.floor(random() * 105) - 2,
				observation_count: random() < 0.1 ? null : Math.floor(random() * 80) - 5,
			}));
			const gaps: [string, string][] =
				random() < 0.3 ? [[day(first, 20), day(first, 20 + Math.floor(random() * 10))]] : [];
			const record = latestCompleteWeek(trend(weeks), availability({ first, last, gaps }));
			kinds.add(record.kind);
			const rule = (holds: boolean, name: string) => {
				if (!holds) broken.push(`record ${n}: ${name}`);
			};
			if (record.kind === 'none') continue;
			const { from, to } = record.week;
			rule(to === day(from, 6), 'a week is seven days');
			rule(from >= first && to <= last, 'a week lies inside the closed record');
			rule(
				!gaps.some(([start, end]) => start <= to && end >= from),
				'a complete week has no published gap',
			);
			rule(
				weeks.every(
					(week) => !(week.date > from && day(week.date, 6) <= last && week.date >= first),
				) || gaps.length > 0,
				'no later complete week was passed over',
			);
			if (record.kind === 'held') {
				const count = record.readings;
				rule(
					record.reason === 'thin'
						? count !== null && Number.isSafeInteger(count) && count >= 0 && count < 30
						: count === null || (Number.isSafeInteger(count) && count >= 0),
					'a held count is a whole number, under the floor when it is the reason',
				);
				continue;
			}
			rule(
				Number.isSafeInteger(record.readings) && record.readings >= 30,
				'readings reach the floor',
			);
			for (const pct of [record.onTimePct, record.previous?.onTimePct ?? 50])
				rule(
					Number.isFinite(pct) && pct >= 0 && pct <= 100 && !Object.is(pct, -0),
					'a share is 0 to 100',
				);
			if (record.previous)
				rule(
					record.previous.week.from === day(from, -7) && record.previous.week.to === day(from, -1),
					'the week before is the seven days before',
				);
		}
		expect(kinds).toEqual(new Set(['week', 'held', 'none']));
		expect(broken).toEqual([]);
	});
});
