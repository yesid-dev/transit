import { describe, expect, it } from 'vitest';
import type { Hotspots } from '#lib/v1/schemas/generated/historic_hotspots.ts';
import { createLineDirectory } from '#lib/site/lineDirectory.ts';
import { lineList, stopList, type InvestigateList, type InvestigateRow } from './homeRanking';

const DAY = 86_400_000;
const at = (instant: string) => Date.parse(instant);
// Published Wednesday November 11; current until the next publication plus 36 hours.
const NOW = at('2026-11-15T12:00:00Z');

const routes = createLineDirectory(
	[
		{ id: '303', short: '303', type: 3 },
		{ id: '301', short: '301', type: 3 },
		{ id: '305', short: '305', type: 3 },
		{ id: '7-354', short: '7', type: 3 },
	],
	{ line: (label) => `Line ${label}` },
);

type Entry = Record<string, unknown>;
function hotspots(entries: Entry[], window = { date: '2026-11-04', window_end: '2026-11-10' }) {
	return {
		generated_utc: '2026-11-11T00:00:00Z',
		by_grain: [
			{
				grain: 'day',
				date: '2026-11-10',
				window_end: '2026-11-10',
				entries: [{ id: '99', type: 'route', rank: 1, severe_pct: 99, observation_count: 500 }],
			},
			{ grain: 'week', ...window, entries },
		],
	} as unknown as Hotspots;
}
const line = (id: string, rank: number, severe_pct: unknown, observation_count: unknown) => ({
	id,
	type: 'route',
	rank,
	name: null,
	severe_pct,
	observation_count,
});

/** Integer half-up rounding, the publisher's rule for non-negative shares. */
const tenths = (part: number, whole: number) => Math.floor((2000 * part + whole) / (2 * whole));
const whole = (part: number, whole: number) => Math.floor((200 * part + whole) / (2 * whole));
/** A ranked weekly stop as the publisher writes it: late readings out of all readings. */
function stop(id: string, name: string | null, rank: number, late: number, readings: number) {
	const onTime = readings - late;
	return {
		id,
		name,
		state: 'ranked',
		rank,
		numerator: onTime,
		denominator: readings,
		pct: whole(onTime, readings),
		severe_pct: tenths(late, readings) / 10,
		window_start: '2026-11-04',
		window_end: '2026-11-10',
	};
}
function weekly(rows: unknown[]) {
	return { generated_utc: '2026-11-11T00:00:00Z', route_ids: [], weekly_stops: rows };
}

const shown = (list: InvestigateList) =>
	list.state === 'ranked'
		? list.rows.map((row) => [row.label, row.latePct, row.readings] as const)
		: list.state;

describe('lines to investigate', () => {
	// Ottawa's week of November 4 to 10 (M1 capture, November 13), out of published order.
	const ottawa = hotspots([
		line('305', 1, 75.6, 127),
		line('301', 2, 84.3, 185),
		line('thin', 3, 100, 29),
		line('303', 4, 85, 173),
		line('7-354', 5, 12.5, 400),
	]);

	it('shows the three highest late shares with their readings and the week’s own dates', () => {
		const list = lineList(ottawa, routes, { now: NOW });
		expect(shown(list)).toEqual([
			['303', 85, 173],
			['301', 84.3, 185],
			['305', 75.6, 127],
		]);
		expect(list).toMatchObject({
			state: 'ranked',
			window: { from: '2026-11-04', to: '2026-11-10' },
			days: 7,
		});
		const first = (list as Extract<InvestigateList, { state: 'ranked' }>).rows[0]!;
		expect(first).toMatchObject({ kind: 'line', id: '303', number: '303', spoken: 'Line 303' });
	});

	it('names a line by number and published name, and speaks both', () => {
		const list = lineList(
			hotspots([{ ...line('7-354', 1, 24, 100), name: 'Carleton <> St-Laurent' }]),
			routes,
			{ now: NOW },
		);
		expect(list.state === 'ranked' && list.rows[0]).toMatchObject({
			number: '7',
			name: 'Carleton <> St-Laurent',
			label: '7 · Carleton <> St-Laurent',
			spoken: 'Line 7 · Carleton <> St-Laurent',
		});
	});

	it('keeps the week through the next publication and its completion allowance', () => {
		for (const now of ['2026-11-18T07:30:00Z', '2026-11-19T18:59:59.999Z'])
			expect(lineList(ottawa, routes, { now: at(now) }).state).toBe('ranked');
		for (const now of [NaN, Infinity, at('2026-11-10T23:59:59Z'), at('2026-11-19T19:00:00Z')])
			expect(lineList(ottawa, routes, { now }).state).toBe('not-current');
		expect(
			lineList({ ...ottawa, generated_utc: 'invalid' } as Hotspots, routes, { now: NOW }).state,
		).toBe('not-current');
	});

	it('says no ranking is published when the file or its week is absent', () => {
		expect(lineList(null, routes, { now: NOW }).state).toBe('unpublished');
		expect(lineList({ ...ottawa, by_grain: [] }, routes, { now: NOW }).state).toBe('unpublished');
	});

	it('withholds a week that is not seven named days', () => {
		for (const window of [
			{ date: '2026-11-10', window_end: '2026-11-04' },
			{ date: '2026-11-05', window_end: '2026-11-10' },
			{ date: 'soon', window_end: '2026-11-10' },
			{ date: null, window_end: '2026-11-10' },
		] as never[])
			expect(
				lineList(hotspots([line('303', 1, 85, 173)], window), routes, { now: NOW }).state,
			).toBe('not-current');
	});

	it('leaves out a repeat, a thin line and any share outside its definition', () => {
		const list = lineList(
			hotspots([
				line('303', 1, 85, 173),
				line('303', 2, 99, 400),
				line('301', 3, 101, 185),
				line('305', 4, -1, 127),
				line('7-354', 5, -0, 100),
				line('thin', 6, 90, 29),
				line('half', 7, 90, 30.5),
				line('none', 8, null, 100),
			]),
			routes,
			{ now: NOW },
		);
		expect(shown(list)).toEqual([
			['303', 85, 173],
			['7', 0, 100],
		]);
		const zero = list.state === 'ranked' ? list.rows[1]!.latePct : NaN;
		expect(Object.is(zero, -0)).toBe(false);
	});
});

describe('stops to investigate', () => {
	// The publisher ranks the on-time share of whole percents with its own tie rules; the home
	// shows the late share to one decimal, so it orders the rows by that shown figure.
	const index = weekly([
		stop('S2', 'MANOTICK MAIN / CURRIER', 1, 40, 47),
		stop('S1', 'Main / Mill', 2, 60, 64),
		stop('S3', 'Longfields / Kilspindie', 3, 44, 53),
		stop('S4', 'Bank / Somerset', 4, 20, 40),
		{ id: 'S5', state: 'too_few_units', window_start: '2026-11-04', window_end: '2026-11-10' },
	]);

	it('shows the three highest late shares with their readings and the week’s own dates', () => {
		const list = stopList(index, { now: NOW });
		expect(shown(list)).toEqual([
			['Main / Mill', 93.8, 64],
			['Manotick Main / Currier', 85.1, 47],
			['Longfields / Kilspindie', 83, 53],
		]);
		expect(list).toMatchObject({
			state: 'ranked',
			window: { from: '2026-11-04', to: '2026-11-10' },
			days: 7,
		});
		expect(list.state === 'ranked' && list.rows[0]).toMatchObject({
			kind: 'stop',
			id: 'S1',
			number: null,
			spoken: 'Main / Mill',
		});
	});

	it('names an unnamed stop by its code', () => {
		const list = stopList(weekly([stop('4930', null, 1, 10, 40)]), { now: NOW });
		expect(shown(list)).toEqual([['4930', 25, 40]]);
	});

	it('keeps the week through the next publication and its completion allowance', () => {
		expect(stopList(index, { now: at('2026-11-19T18:59:59Z') }).state).toBe('ranked');
		expect(stopList(index, { now: at('2026-11-19T19:00:00Z') }).state).toBe('not-current');
		expect(stopList({ ...index, generated_utc: 'invalid' }, { now: NOW }).state).toBe(
			'not-current',
		);
	});

	it('says no ranking is published when the file has no weekly stops', () => {
		expect(stopList(null, { now: NOW }).state).toBe('unpublished');
		expect(stopList(weekly([]), { now: NOW }).state).toBe('unpublished');
		expect(stopList({ generated_utc: '2026-11-11T00:00:00Z' }, { now: NOW }).state).toBe(
			'unpublished',
		);
	});

	it('refuses a file whose share does not follow from its readings', () => {
		const broken = { ...stop('S1', 'Main / Mill', 1, 60, 64), severe_pct: 50 };
		expect(stopList(weekly([broken]), { now: NOW }).state).toBe('not-current');
	});
});

describe('every list keeps its figures inside their definitions', () => {
	it('holds for 1,000 seeded line and stop files', () => {
		let seed = 20261115;
		const random = () => {
			seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
			return seed / 2_147_483_648;
		};
		const pick = <T>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
		const states = new Set<string>();
		const broken = new Set<string>();
		const rule = (holds: boolean, name: string) => {
			if (!holds) broken.add(name);
		};
		/** Rules any shown list keeps, given the rows it could have shown. */
		const check = (list: InvestigateList, eligible: readonly { id: string; late: number }[]) => {
			states.add(list.state);
			if (list.state !== 'ranked') return;
			const rows: readonly InvestigateRow[] = list.rows;
			rule(rows.length >= 1 && rows.length <= 3, 'one to three rows');
			rule(new Set(rows.map((row) => row.id)).size === rows.length, 'each place once');
			for (const row of rows) {
				rule(Number.isFinite(row.latePct), 'a share is a number');
				rule(row.latePct >= 0 && row.latePct <= 100, 'a share is between 0 and 100%');
				rule(!Object.is(row.latePct, -0) && !Object.is(row.readings, -0), 'no negative zero');
				rule(Number.isSafeInteger(row.readings) && row.readings >= 30, 'readings are whole, 30+');
			}
			for (let i = 1; i < rows.length; i++)
				rule(rows[i]!.latePct <= rows[i - 1]!.latePct, 'rows follow their shown share');
			const last = rows.at(-1)!.latePct;
			const left = eligible.filter((entry) => !rows.some((row) => row.id === entry.id));
			rule(
				rows.length === 3 || left.length === 0,
				'fewer than three rows only when no other place qualifies',
			);
			rule(
				left.every((entry) => entry.late <= last),
				'no place left out has a higher share',
			);
			const span = (Date.parse(list.window.to) - Date.parse(list.window.from)) / DAY + 1;
			rule(list.days === span && span === 7, 'seven days, as its dates say');
		};

		for (let n = 0; n < 1_000; n++) {
			const lines = Array.from({ length: Math.floor(random() * 8) }, (_, i) => ({
				id: pick(['303', '301', '305', '7-354', 'A', 'B', 'C']),
				rank: i + 1,
				severe_pct: pick([
					null,
					-0,
					-3,
					0,
					12.5,
					50,
					50,
					84.3,
					85,
					100,
					104,
					Math.floor(random() * 1001) / 10,
				]),
				observation_count: pick([
					null,
					-5,
					0,
					29,
					29.5,
					30,
					31,
					173,
					185,
					Math.floor(random() * 500),
				]),
			}));
			const lineFile = hotspots(lines.map((entry) => ({ ...entry, type: 'route', name: null })));
			const seen = new Set<string>();
			const eligibleLines = lines.filter((entry) => {
				const first = !seen.has(entry.id);
				seen.add(entry.id);
				const share = entry.severe_pct;
				const count = entry.observation_count;
				return (
					first &&
					share != null &&
					share >= 0 &&
					share <= 100 &&
					count != null &&
					Number.isSafeInteger(count) &&
					count >= 30
				);
			});
			check(
				lineList(lineFile, routes, { now: NOW }),
				eligibleLines.map((entry) => ({ id: entry.id, late: entry.severe_pct! })),
			);

			const ids = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'].filter(() => random() < 0.6);
			const stops = ids.map((id, i) => {
				const readings = pick([30, 31, 40, 64, Math.floor(random() * 400) + 30]);
				return random() < 0.15
					? { id, state: 'too_few_units', window_start: '2026-11-04', window_end: '2026-11-10' }
					: stop(
							id,
							random() < 0.2 ? null : `STOP ${id}`,
							i + 1,
							Math.floor(random() * (readings + 1)),
							readings,
						);
			});
			check(
				stopList(weekly(stops), { now: NOW }),
				stops
					.filter((row) => row.state === 'ranked')
					.map((row) => ({ id: row.id, late: (row as ReturnType<typeof stop>).severe_pct })),
			);
		}
		expect([...broken]).toEqual([]);
		expect([...states].sort()).toEqual(['not-current', 'ranked', 'unpublished']);
	});
});
