import { describe, expect, it } from 'vitest';
import { NetworkFileSchema, type NetworkFile } from '#lib/v1/schemas/network.ts';
import { selectLivePulse, type LivePulse } from './homePulse';

/*
 * Owner ruling 6: every figure the home live strip shows is checked against its definition, never
 * against an earlier output. A fleet is counted bus by bus the way the publisher counts it
 * (apps/db snapshots/builders/live.py, build_network): each bus in service has exactly one status,
 * and the on-time share is on-time plus 1 to 5 min late buses over the buses with a reading.
 */

type Status = 'on_time' | 'late' | 'severe' | 'early' | 'unknown';
const STATUSES: readonly Status[] = ['on_time', 'late', 'severe', 'early', 'unknown'];

/** Readings a headlined share needs (MIN_N_RATE): fewer, and the strip says so instead. */
const READING_FLOOR = 30;

/** Percentages are rounded half away from zero, as the publisher rounds them. */
const roundHalfAway = (value: number) => Math.sign(value) * Math.round(Math.abs(value));

/** A live network file as the reader receives it: parsed by the published schema. */
function published(fields: Record<string, unknown>): NetworkFile {
	return NetworkFileSchema.parse({
		generated_utc: '2026-11-15T07:07:30Z',
		delay_p50_min: null,
		delay_p90_min: null,
		feed_freshness_s: 20,
		coverage_pct: null,
		non_responding: 0,
		...fields,
	});
}

/** Counts each bus once and computes the share from those counts, as the publisher does. */
function fleet(statuses: readonly Status[], { notReporting = 0, shareNotPublished = false } = {}) {
	const dist = { on_time: 0, late: 0, severe: 0, early: 0, unknown: 0 };
	for (const status of statuses) dist[status] += 1;
	const known = statuses.length - dist.unknown;
	return published({
		vehicles_in_service: statuses.length,
		status_dist: dist,
		on_time_pct:
			known > 0 && !shareNotPublished
				? roundHalfAway((100 * (dist.on_time + dist.late)) / known)
				: null,
		non_responding: notReporting,
	});
}

/** Deterministic fleets, so a failure names one that can be replayed. */
function seededFleets(count: number, seed: number) {
	let state = seed;
	const random = () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	// Sizes on and around the floors first, then anything up to a rush-hour fleet.
	const edges = [0, 1, 2, 29, 30, 31, 59, 60, 61];
	return Array.from({ length: count }, (_, index) => {
		const size = edges[index] ?? Math.floor(random() * 600);
		// Cubed weights skew the mix, so some fleets are almost all one status.
		const weights = STATUSES.map(() => random() ** 3);
		const total = weights.reduce((sum, weight) => sum + weight, 0);
		const statuses = Array.from({ length: size }, () => {
			let pick = random() * total;
			return STATUSES.find((_, i) => (pick -= weights[i]) < 0) ?? 'unknown';
		});
		const net = fleet(statuses, {
			notReporting: Math.floor(random() * 40),
			shareNotPublished: random() < 0.05,
		});
		return { index, size, net };
	});
}

function numbersIn(value: unknown): number[] {
	if (typeof value === 'number') return [value];
	if (value && typeof value === 'object') return Object.values(value).flatMap(numbersIn);
	return [];
}

/** Every rule the strip's figures must keep, as the list of the ones a pulse breaks. */
function brokenRules(net: NetworkFile, pulse: LivePulse | null): string[] {
	if (!pulse) return ['a published file has a pulse'];
	const broken: string[] = [];
	const rule = (holds: boolean, name: string) => {
		if (!holds) broken.push(name);
	};
	const d = net.status_dist;
	const late = pulse.severeLate ?? 0;
	const early = pulse.early ?? 0;

	const values = numbersIn(pulse);
	rule(values.every(Number.isFinite), 'no NaN or infinity');
	rule(!values.some((value) => Object.is(value, -0)), 'no negative zero');
	rule(
		[pulse.inService, pulse.withReading, pulse.notReporting, late, early].every(
			(count) => Number.isSafeInteger(count) && count >= 0,
		),
		'counts are whole and never negative',
	);
	rule(
		pulse.withReading + d.unknown === pulse.inService,
		'buses with and without a reading add up to the buses in service',
	);
	rule(
		d.on_time + d.late + d.severe + d.early === pulse.withReading,
		'the four statuses add up to the buses with a reading',
	);
	rule(pulse.withReading <= pulse.inService, 'buses with a reading <= buses in service');
	rule(late + early <= pulse.withReading, 'late + early <= buses with a reading');
	rule(
		(pulse.severeLate === null) === (pulse.withReading === 0) &&
			(pulse.early === null) === (pulse.withReading === 0),
		'a count is absent exactly when no bus has a reading, never a reassuring zero',
	);

	const share = pulse.onTime;
	if (share.kind === 'absent') {
		rule(
			net.on_time_pct == null || pulse.inService === 0,
			'the share is absent only when none is published or no bus runs',
		);
		return broken;
	}
	rule(
		share.readings === pulse.withReading && share.inService === pulse.inService,
		'the share is out of the same buses as the late count',
	);
	const enough = share.readings >= READING_FLOOR && share.readings * 2 >= share.inService;
	if (share.kind === 'thin') {
		rule(!enough, 'a share is held back only below the reading floor');
		return broken;
	}
	rule(enough, 'a headlined share rests on enough readings');
	rule(share.pct >= 0 && share.pct <= 100, 'the on-time share is between 0 and 1');
	rule(
		share.pct === roundHalfAway((100 * (pulse.withReading - late - early)) / pulse.withReading),
		'the on-time share is the measured buses neither late nor early',
	);
	return broken;
}

describe('home live strip: figures proven from their definitions', () => {
	it('keeps every rule for 2,000 seeded fleets, from an empty night to a rush hour', () => {
		const fleets = seededFleets(2000, 20261115);
		const kinds = new Set(fleets.map(({ net }) => selectLivePulse(net)?.onTime.kind));
		expect(kinds).toEqual(new Set(['share', 'thin', 'absent']));
		const broken = fleets.flatMap(({ index, size, net }) =>
			brokenRules(net, selectLivePulse(net)).map(
				(name) => `fleet ${index} (${size} buses): ${name}`,
			),
		);
		expect(broken).toEqual([]);
	});

	it.each([
		{
			case: 'no bus in service: nothing to divide by',
			file: { vehicles_in_service: 0, status_dist: {}, on_time_pct: null },
			pulse: {
				inService: 0,
				onTime: { kind: 'absent' },
				severeLate: null,
				withReading: 0,
				early: null,
				notReporting: 0,
			},
		},
		{
			case: 'buses running, none with a delay reading',
			file: { vehicles_in_service: 12, status_dist: { unknown: 12 }, on_time_pct: null },
			pulse: {
				inService: 12,
				onTime: { kind: 'absent' },
				severeLate: null,
				withReading: 0,
				early: null,
				notReporting: 0,
			},
		},
		{
			case: 'a thin sample: 40 readings, fewer than half of 81 buses',
			file: {
				vehicles_in_service: 81,
				status_dist: { on_time: 30, late: 6, severe: 3, early: 1, unknown: 41 },
				on_time_pct: 90,
			},
			pulse: {
				inService: 81,
				onTime: { kind: 'thin', readings: 40, inService: 81 },
				severeLate: 3,
				withReading: 40,
				early: 1,
				notReporting: 0,
			},
		},
		{
			case: 'exactly on the floor: 30 readings, half of 60 buses',
			file: {
				vehicles_in_service: 60,
				status_dist: { on_time: 20, late: 4, severe: 3, early: 3, unknown: 30 },
				on_time_pct: 80,
			},
			pulse: {
				inService: 60,
				onTime: { kind: 'share', pct: 80, readings: 30, inService: 60 },
				severeLate: 3,
				withReading: 30,
				early: 3,
				notReporting: 0,
			},
		},
		{
			case: 'no share published although 50 buses were measured',
			file: {
				vehicles_in_service: 50,
				status_dist: { on_time: 40, late: 5, severe: 3, early: 2 },
				on_time_pct: null,
				non_responding: 4,
			},
			pulse: {
				inService: 50,
				onTime: { kind: 'absent' },
				severeLate: 3,
				withReading: 50,
				early: 2,
				notReporting: 4,
			},
		},
		{
			case: 'statuses left out of the file count as none, and 87.5% rounds to 88%',
			file: {
				vehicles_in_service: 40,
				status_dist: { on_time: 25, late: 10, severe: 2, early: 3 },
				on_time_pct: 88,
			},
			pulse: {
				inService: 40,
				onTime: { kind: 'share', pct: 88, readings: 40, inService: 40 },
				severeLate: 2,
				withReading: 40,
				early: 3,
				notReporting: 0,
			},
		},
	])('$case', ({ file, pulse }) => {
		const net = published(file);
		expect(selectLivePulse(net)).toEqual(pulse);
		expect(brokenRules(net, selectLivePulse(net))).toEqual([]);
	});

	it('reads the published files of 2026-11-15 07:07 UTC as their counts say', () => {
		// https://data.yesid.dev/v1/stm/live/network.json, generated 07:07:30Z.
		const stm = published({
			vehicles_in_service: 175,
			status_dist: { on_time: 71, late: 55, severe: 9, early: 10, unknown: 30 },
			on_time_pct: 87,
			non_responding: 7,
		});
		// https://data.yesid.dev/v1/octranspo/live/network.json, generated 07:07:40Z.
		const ottawa = published({
			vehicles_in_service: 28,
			status_dist: { on_time: 4, late: 5, severe: 1, early: 4, unknown: 14 },
			on_time_pct: 64,
			non_responding: 0,
		});
		// 126 of 145 measured buses are neither late nor early: 86.9%, shown as 87%.
		expect(selectLivePulse(stm)).toEqual({
			inService: 175,
			onTime: { kind: 'share', pct: 87, readings: 145, inService: 175 },
			severeLate: 9,
			withReading: 145,
			early: 10,
			notReporting: 7,
		});
		// 14 readings: below the floor, so the strip says so instead of headlining 64%.
		expect(selectLivePulse(ottawa)).toEqual({
			inService: 28,
			onTime: { kind: 'thin', readings: 14, inService: 28 },
			severeLate: 1,
			withReading: 14,
			early: 4,
			notReporting: 0,
		});
		expect(brokenRules(stm, selectLivePulse(stm))).toEqual([]);
		expect(brokenRules(ottawa, selectLivePulse(ottawa))).toEqual([]);
	});
});
