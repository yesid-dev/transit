import { describe, expect, it } from 'vitest';
import { presentStopRecord, type StopRecordContext } from './stopRecord';

// One published weekly index, generated from a small seed: the stop under test plus
// neighbours. Ranked rows carry evidence that agrees with their shares, as the contract asks.
const PUBLISHED = '2026-11-11T07:30:00Z';
const NOW = Date.parse('2026-11-13T15:00:00Z');
const WINDOW = { window_start: '2026-11-04', window_end: '2026-11-10' };

function ranked(id: string, readings: number, late: number, rank = 1) {
	const notLate = readings - late;
	return {
		state: 'ranked' as const,
		id,
		name: `Stop ${id}`,
		rank,
		numerator: notLate,
		denominator: readings,
		pct: Math.round((100 * notLate) / readings),
		severe_pct: Math.round((1000 * late) / readings) / 10,
		...WINDOW,
	};
}

function index(rows: unknown[] | null, extra: Record<string, unknown> = {}) {
	return {
		generated_utc: PUBLISHED,
		published_utc: PUBLISHED,
		next_publish_utc: '2026-11-18T07:00:00Z',
		weekly_routes: null,
		weekly_stops: rows,
		...extra,
	};
}

const CONTEXT: StopRecordContext = {
	operator: 'STM',
	stopId: '52409',
	stopCode: '52409',
	stopName: 'Sherbrooke / Saint-Denis',
	url: 'https://transit.example/stop/52409',
};

const settled = (data: unknown) => ({ data, error: null, settled: true });

describe('presentStopRecord: the published weekly figure', () => {
	it('names the measure, its seven-day period and the same share the home page ranks', () => {
		const view = presentStopRecord(
			{ stopId: '52409', index: settled(index([ranked('52409', 210, 120)])), now: NOW },
			'en',
			CONTEXT,
		);
		expect(view.state).toBe('measured');
		expect(view.measure).toBe('Readings more than 5 minutes late');
		expect(view.period).toBe('November 4 to 10, 2026 · 7 complete days');
		expect(view.figure).toBe('57.1%');
		expect(view.sentence).toBe(' of readings indicated a delay of more than 5 minutes.');
		expect(view.evidence).toEqual([
			{ label: 'Readings', value: '210 readings; 120 more than 5 minutes late.' },
			{ label: 'Uncertainty', value: 'No interval published for this measure and period.' },
		]);
	});

	it('speaks French with French typography and the first of the month as « 1er »', () => {
		const row = {
			...ranked('52409', 210, 120),
			window_start: '2026-11-01',
			window_end: '2026-11-07',
		};
		const view = presentStopRecord(
			{ stopId: '52409', index: settled(index([row])), now: NOW },
			'fr',
			CONTEXT,
		);
		expect(view.period).toBe('Du 1er au 7 novembre 2026 · 7 jours complets');
		expect(view.figure).toBe('57,1 %');
		expect(view.sentence).toBe(' des relevés indiquaient plus de 5 minutes de retard.');
		expect(view.evidence[0]).toEqual({
			label: 'Relevés',
			value: '210 relevés; 120 à plus de 5 minutes de retard.',
		});
	});

	it('names both months when the week crosses one, and both years across a new year', () => {
		const cross = (start: string, end: string, locale: 'en' | 'fr') =>
			presentStopRecord(
				{
					stopId: '52409',
					index: settled(
						index([{ ...ranked('52409', 40, 4), window_start: start, window_end: end }]),
					),
					now: NOW,
				},
				locale,
				CONTEXT,
			).period;
		expect(cross('2026-10-29', '2026-11-04', 'en')).toBe(
			'October 29 to November 4, 2026 · 7 complete days',
		);
		expect(cross('2026-10-29', '2026-11-04', 'fr')).toBe(
			'Du 29 octobre au 4 novembre 2026 · 7 jours complets',
		);
		expect(cross('2025-12-29', '2026-01-04', 'en')).toBe(
			'December 29, 2025 to January 4, 2026 · 7 complete days',
		);
	});

	it('shows a measured zero as 0%, never as missing', () => {
		const view = presentStopRecord(
			{ stopId: '52409', index: settled(index([ranked('52409', 64, 0)])), now: NOW },
			'en',
			CONTEXT,
		);
		expect(view.figure).toBe('0%');
		expect(view.evidence[0].value).toBe('64 readings; 0 more than 5 minutes late.');
	});

	it('offers a one-row CSV and a citation built from the same figure', () => {
		const view = presentStopRecord(
			{ stopId: '52409', index: settled(index([ranked('52409', 210, 120)])), now: NOW },
			'en',
			CONTEXT,
		);
		expect(view.csv?.filename).toBe('transit-stm-stop-52409-2026-11-04-to-2026-11-10.csv');
		expect(view.csv?.text).toBe(
			'operator,stop_id,stop_code,stop_name,measure,window_start,window_end,readings,late_readings,late_share_pct\r\n' +
				'STM,52409,52409,Sherbrooke / Saint-Denis,readings_more_than_5_min_late,2026-11-04,2026-11-10,210,120,57.1\r\n',
		);
		expect(view.citation).toBe(
			'Transit (unofficial website). STM, stop 52409 “Sherbrooke / Saint-Denis”: 57.1% of readings more than 5 minutes late, November 4 to 10, 2026. https://transit.example/stop/52409',
		);
	});

	it('quotes CSV cells that hold a comma or a quote', () => {
		const view = presentStopRecord(
			{ stopId: '52409', index: settled(index([ranked('52409', 210, 120)])), now: NOW },
			'en',
			{ ...CONTEXT, stopName: 'Parc, "Nord"' },
		);
		expect(view.csv?.text.split('\r\n')[1]).toContain(',"Parc, ""Nord""",');
	});
});

describe('presentStopRecord: absence is never a reassuring zero', () => {
	const sentence = (input: Parameters<typeof presentStopRecord>[0], locale: 'en' | 'fr' = 'en') => {
		const view = presentStopRecord(input, locale, CONTEXT);
		expect(view.figure).toBeNull();
		expect(view.csv).toBeNull();
		expect(view.citation).toBeNull();
		return [view.state, view.status];
	};

	it('keeps loading, failure, unpublished, out-of-date and unlisted apart', () => {
		const at = (value: { data: unknown; error: unknown; settled: boolean }) => ({
			stopId: '52409',
			index: value,
			now: NOW,
		});
		expect(sentence(at({ data: null, error: null, settled: false }))).toEqual([
			'pending',
			'Loading the weekly record…',
		]);
		expect(sentence(at({ data: null, error: new Error('down'), settled: true }))).toEqual([
			'failed',
			'The weekly record could not be read.',
		]);
		expect(sentence(at(settled({ nonsense: true })))).toEqual([
			'failed',
			'The weekly record could not be read.',
		]);
		expect(sentence(at(settled(index(null))))).toEqual([
			'unpublished',
			'No weekly record has been published yet.',
		]);
		expect(sentence(at(settled(null)))).toEqual([
			'unpublished',
			'No weekly record has been published yet.',
		]);
		expect(
			sentence({
				...at(settled(index([ranked('52409', 210, 120)]))),
				now: Date.parse('2026-12-01'),
			}),
		).toEqual(['not-current', 'No current weekly record is available.']);
		expect(sentence(at(settled(index([ranked('11000', 210, 120)]))))).toEqual([
			'not-listed',
			'This stop is not in the latest weekly record.',
		]);
	});

	it('keeps the same two evidence rows in every state, saying what is not published', () => {
		const rows = (data: unknown, settledFlag = true) =>
			presentStopRecord(
				{ stopId: '52409', index: { data, error: null, settled: settledFlag }, now: NOW },
				'en',
				CONTEXT,
			).evidence;
		expect(rows(null, false)).toEqual([
			{ label: 'Readings', value: null },
			{ label: 'Uncertainty', value: null },
		]);
		const unpublished = [
			{ label: 'Readings', value: 'Reading count not published for this result.' },
			{ label: 'Uncertainty', value: 'No interval published for this measure and period.' },
		];
		expect(rows(index(null))).toEqual(unpublished);
		expect(
			rows(index([ranked('11000', 90, 9), { state: 'too_few_units', id: '52409', ...WINDOW }])),
		).toEqual(unpublished);
	});

	it.each([
		['too_few_units', 'Too few readings in this period to publish a share.'],
		['too_few_trips', 'Too few readings in this period to publish a share.'],
		['no_live_data', 'No live data for the lines serving this stop in this period.'],
		['not_measured', 'This measure is not published for this stop in this period.'],
		['not_defined', 'This measure is not published for this stop in this period.'],
	])('says why %s has no share, with its period', (state, status) => {
		const rows = [ranked('11000', 210, 120), { state, id: '52409', ...WINDOW }];
		const view = presentStopRecord(
			{ stopId: '52409', index: settled(index(rows)), now: NOW },
			'en',
			CONTEXT,
		);
		expect([view.state, view.status, view.figure]).toEqual(['unmeasured', status, null]);
		expect(view.period).toBe('November 4 to 10, 2026 · 7 complete days');
	});

	it('speaks each absence in French', () => {
		const rows = [ranked('11000', 210, 120), { state: 'too_few_units', id: '52409', ...WINDOW }];
		expect(
			presentStopRecord({ stopId: '52409', index: settled(index(rows)), now: NOW }, 'fr', CONTEXT)
				.status,
		).toBe('Trop peu de relevés pendant cette période pour publier une part.');
		expect(
			presentStopRecord({ stopId: '52409', index: settled(index(null)), now: NOW }, 'fr', CONTEXT)
				.status,
		).toBe('Aucun bilan hebdomadaire n’a encore été publié.');
	});
});

describe('presentStopRecord: every shown number passes its math checks', () => {
	// Seeded rows across the whole share range, plus the stop under test at each one.
	const seeds = Array.from({ length: 40 }, (_, i) => ({
		readings: 30 + i * 17,
		late: (i * 37) % (31 + i * 17),
	}));

	it.each(seeds)('readings $readings, late $late', ({ readings, late }) => {
		const bounded = Math.min(late, readings);
		const view = presentStopRecord(
			{ stopId: '52409', index: settled(index([ranked('52409', readings, bounded)])), now: NOW },
			'en',
			CONTEXT,
		);
		expect(view.state).toBe('measured');
		const share = view.share!;
		expect(share.readings).toBe(readings);
		expect(share.lateReadings).toBe(bounded);
		expect(share.lateReadings).toBeLessThanOrEqual(share.readings);
		expect(share.lateReadings).toBeGreaterThanOrEqual(0);
		expect(share.latePct).toBeGreaterThanOrEqual(0);
		expect(share.latePct).toBeLessThanOrEqual(100);
		expect(Number.isFinite(share.latePct)).toBe(true);
		expect(Object.is(share.latePct, -0)).toBe(false);
		expect(Math.abs(share.latePct - (100 * bounded) / readings)).toBeLessThanOrEqual(0.05);
		expect(view.figure).not.toMatch(/NaN|Infinity|-0/);
	});

	it('refuses a row whose late readings exceed its readings, or whose share disagrees', () => {
		const broken = [
			{ ...ranked('52409', 50, 10), numerator: 60 },
			{ ...ranked('52409', 50, 10), severe_pct: 35 },
		];
		for (const row of broken) {
			const view = presentStopRecord(
				{ stopId: '52409', index: settled(index([row])), now: NOW },
				'en',
				CONTEXT,
			);
			expect([view.state, view.figure]).toEqual(['failed', null]);
		}
	});
});
