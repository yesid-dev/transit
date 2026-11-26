import { describe, expect, it } from 'vitest';
import type { DelayDistribution, RecordCell, RecordSeries } from '#lib/server/engine.ts';
import {
	bandChart,
	histogramChart,
	hourChart,
	rangeChart,
	stopLadderChart,
	trendChart,
} from './recordCharts.ts';

const cell = (key: Record<string, string | number>, patch: Partial<RecordCell> = {}) =>
	({
		key,
		state: 'measured',
		state_text: { en: 'Measured', fr: 'Mesuré' },
		value: { on_time: 0.751, early: 0.083, late: 0.166 },
		evidence: { counts: { classified: 58, on_time: 44, early: 4, late: 10 } },
		...patch,
	}) as RecordSeries['cells'][number];

const series = (...cells: RecordSeries['cells']) =>
	({ cells, evidence: { days_not_measured: [] } }) as unknown as RecordSeries;

describe('record charts', () => {
	it.each([
		[
			'en',
			'More than 5 min early',
			'+5:01 to +5:59',
			'15 min late or more',
			'24.0%',
			'Stop events',
		],
		[
			'fr',
			'Plus de 5 min d’avance',
			'+5:01 à +5:59',
			'15 min de retard ou plus',
			'24,0 %',
			'Passages aux arrêts',
		],
	] as const)(
		'presents exact delay ranges and counts in %s',
		(locale, early, late, end, share, events) => {
			const cells = [
				{
					key: { min_seconds: null, max_seconds: -301, band: 'early' },
					value: { delay_distribution: 0, stop_events: 0 },
				},
				{
					key: { min_seconds: 301, max_seconds: 359, band: 'late' },
					value: { delay_distribution: 0.24, stop_events: 24 },
				},
				{
					key: { min_seconds: 900, max_seconds: null, band: 'late' },
					value: { delay_distribution: 0, stop_events: 0 },
				},
			] satisfies Pick<DelayDistribution['cells'][number], 'key' | 'value'>[];
			const chart = histogramChart({ cells, state: 'measured' }, 'Distribution', locale);
			expect(chart.props.points).toEqual([
				{ x: -5.5, y: 0 },
				{ x: 5.5, y: 0.24 },
				{ x: 15.5, y: 0 },
			]);
			expect(chart.props.ticks.map(({ label }) => label)).toEqual(['-1', '0', '+5', '+10']);
			expect(chart.props.yDomain).toEqual([0, 0.25]);
			expect(chart.table.columns.value).toBe(events);
			expect(chart.table.rows.map(({ label }) => label)).toEqual([early, late, end]);
			expect(chart.table.rows[1]).toMatchObject({ value: '24', detail: share });
			expect(
				histogramChart({ cells: [], state: 'not_measured' }, 'Distribution', locale).table.rows,
			).toEqual([]);
		},
	);

	it('keeps the three engine shares and counts with localized readings', () => {
		expect(bandChart(cell({}), 'Bands', 'en').props.bands[2]).toMatchObject({
			share: 0.166,
			valueLabel: '16.6%',
			detail: '10 stop events',
		});
		expect(bandChart(cell({}), 'Bands', 'fr').props.bands[2]?.detail).toBe(
			'10 passages aux arrêts',
		);
	});

	it('names measured, few and no-service cells and withholds numeric levels for states', () => {
		const data = series(
			cell({ weekday: 1, hour: 6 }),
			cell({ weekday: 2, hour: 5 }),
			cell({ weekday: 2, hour: 0 }),
			...Array.from({ length: 15 }, (_, index) => cell({ weekday: 2, hour: index + 9 })),
			cell({ weekday: 1, hour: 7 }, { state: 'too_few_to_judge' }),
			cell(
				{ weekday: 1, hour: 8 },
				{
					state: 'unknown',
					evidence: { counts: { scheduled: 0 }, days_included: [] },
				},
			),
		);
		const grid = hourChart(
			{ ...data, info: [{ id: 'late', minimum_sample: 30 }] },
			'Hours',
			'en',
		).props;
		expect(grid.columns.map(({ label }) => label)).toEqual([
			'05h',
			'06h',
			'07h',
			'08h',
			'09h',
			'10h',
			'11h',
			'12h',
			'13h',
			'14h',
			'15h',
			'16h',
			'17h',
			'18h',
			'19h',
			'20h',
			'21h',
			'22h',
			'23h',
			'00h',
		]);
		expect(grid.stateLabels.few).toBe('few: too few to judge, under 30 stop events');
		expect(grid.rows[0]?.cells[1]).toMatchObject({
			text: '17',
			name: 'Monday, 06h: 16.6% late, 58 stop events',
		});
		expect(grid.rows[0]?.cells[2]).toMatchObject({ text: 'few', level: null, state: 'few' });
		expect(grid.rows[0]?.cells[3]).toMatchObject({
			text: 'none',
			level: null,
			state: 'none',
			name: 'Monday, 08h: no service at that hour',
		});
		expect(grid.rows[1]?.cells[3]?.state).toBe('unmeasured');
		expect(hourChart(data, 'Heures', 'fr').props.rows[0]?.cells[1]?.name).toMatch(
			/lundi, 6 h : 16,6\s% en retard, 58 passages aux arrêts/,
		);
	});

	it.each([
		['en', '00h', '23h', 'few', 'none'],
		['fr', '0 h', '23 h', 'peu', 'aucun'],
	] as const)(
		'keeps all 24 active hours and every named state in %s',
		(locale, firstHour, lastHour, fewWord, noneWord) => {
			const data = series(
				...Array.from({ length: 24 }, (_, hour) => {
					if (hour === 0) return cell({ weekday: 1, hour }, { state: 'not_measured' });
					if (hour === 1) return cell({ weekday: 1, hour }, { state: 'too_few_to_judge' });
					if (hour === 2)
						return cell(
							{ weekday: 1, hour },
							{
								state: 'unknown',
								evidence: { counts: { scheduled: 0 }, days_included: [] },
							},
						);
					return cell({ weekday: 1, hour });
				}),
				...Array.from({ length: 24 }, (_, hour) => cell({ weekday: 2, hour })),
			);
			const grid = hourChart(
				{ ...data, info: [{ id: 'late', minimum_sample: 60 }] },
				'Hours',
				locale,
			).props;
			expect(grid.columns).toHaveLength(24);
			expect(grid.columns[0]?.label).toBe(firstHour);
			expect(grid.columns[23]?.label).toBe(lastHour);
			expect(grid.rows[0]?.cells[0]).toMatchObject({ state: 'unmeasured', level: null });
			expect(grid.rows[0]?.cells[1]).toMatchObject({ state: 'few', text: fewWord, level: null });
			expect(grid.rows[0]?.cells[2]).toMatchObject({ state: 'none', text: noneWord, level: null });
			expect(grid.rows[0]?.cells[23]).toMatchObject({ text: '17' });
		},
	);

	it('keeps gaps in daily readings and aligns the reference to the same dates', () => {
		const data = series(
			cell({ day: '2026-11-08' }),
			cell({ day: '2026-11-09' }, { state: 'not_measured' }),
			cell({ day: '2026-11-10' }),
		);
		const reference = series(cell({ day: '2026-11-10' }, { value: { on_time: 0.807 } }));
		const chart = trendChart(data, 'Daily', 'en', reference);
		expect(chart.props.points.map(({ y }) => y)).toEqual([0.751, null, 0.751]);
		expect(chart.props.reference.map(({ y }) => y)).toEqual([null, null, 0.807]);
		expect(chart.table.rows[0]?.value).toBe('75.1%');
		expect(chart.props.yDomain).toEqual([0.75, 0.85]);
		expect(chart.props.ticks.map(({ label }) => label)).toEqual(['8 Nov', '10 Nov']);
		expect(chart.props.last?.label).toBe('75.1%');
	});

	it.each([
		[
			'en',
			'Too few stop events per day to draw this stop’s line on some days (minimum 30 per day).',
		],
		[
			'fr',
			'Trop peu de passages aux arrêts certains jours pour tracer la courbe de cet arrêt (minimum de 30 par jour).',
		],
	] as const)(
		'draws low stop values on the network axis and explains a sparse day in %s',
		(locale, notice) => {
			const dates = ['2026-11-08', '2026-11-09', '2026-11-10'];
			const stop = series(
				cell({ day: dates[0] }, { value: { on_time: 0.204 } }),
				cell({ day: dates[1] }, { state: 'too_few_to_judge', value: { on_time: 0.26 } }),
				cell({ day: dates[2] }, { value: { on_time: 0.25 } }),
			);
			const network = series(...dates.map((day) => cell({ day }, { value: { on_time: 0.807 } })));
			const { props } = trendChart(
				{ ...stop, info: [{ id: 'on_time', minimum_sample: 30 }] },
				'Daily',
				locale,
				network,
				true,
			);
			expect(props.points.map(({ y }) => y)).toEqual([0.204, null, 0.25]);
			expect(props.yDomain).toEqual([0, 1]);
			expect(props.yTicks.map(({ value }) => value)).toEqual([0, 0.25, 0.5, 0.75, 1]);
			expect(props.gapNote).toBe(notice);
		},
	);

	it.each([
		['en', ['75%', '80%', '85%'], '85.0%'],
		['fr', ['75 %', '80 %', '85 %'], '85,0 %'],
	] as const)(
		'keeps whole trend ticks and a one-decimal end label in %s',
		(locale, ticks, last) => {
			const chart = trendChart(
				series(
					cell({ day: '2026-11-08' }),
					cell({ day: '2026-11-09' }, { value: { on_time: 0.85 } }),
				),
				'Daily',
				locale,
			);
			expect(chart.props.yTicks.map(({ label }) => label.replace(/\s/gu, ' '))).toEqual(ticks);
			expect(chart.props.last?.label.replace(/\s/gu, ' ')).toBe(last);
		},
	);

	it('uses the engine interval without recalculating its endpoints', () => {
		const chart = rangeChart(
			{ value: 0.751, range: { lower: 0.706, upper: 0.758 } },
			'On-time share',
			'en',
			0.807,
		);
		expect(chart.props).toMatchObject({
			low: 0.706,
			high: 0.758,
			value: 0.751,
			reference: { value: 0.807 },
		});
		expect(chart.props.label).toBe('On-time share: 75.1%, 70.6% to 75.8%; network at 80.7%.');
	});

	it('keeps the engine stop order and separates a real zero from a state', () => {
		const chart = stopLadderChart(
			series(
				cell({ stop: 'B' }, { value: { median_delay: 0 } }),
				cell({ stop: 'A' }, { state: 'no_live_data' }),
			),
			'Delay',
			'fr',
			(id) => ({ name: id }),
		);
		expect(chart.props.stops).toMatchObject([
			{ id: 'B/0', value: 0 },
			{ id: 'A/1', value: null, state: 'Aucune donnée en direct' },
		]);
	});
	it.each([
		['en', '1 min early', 'Not measured'],
		['fr', '1 min d’avance', 'Non mesuré'],
	] as const)(
		'uses the chosen day’s reported delay and labels missing stops in %s',
		(locale, delay, missing) => {
			const chart = stopLadderChart(
				series(
					cell(
						{ stop: 'B' },
						{
							state: 'too_few_to_judge',
							evidence: {
								counts: { classified: 1 },
								days_included: [],
								observed_delay_seconds: -61,
							},
						},
					),
					cell({ stop: 'A' }, { state: 'not_measured' }),
				),
				'Delay',
				locale,
				(id) => ({ name: id }),
				true,
			);
			expect(chart.table.columns.label).toBe(locale === 'fr' ? 'Arrêt' : 'Stop');
			expect(chart.props.stops[0]).toMatchObject({ value: -61, valueLabel: delay });
			expect(chart.props.stops[1]).toMatchObject({ value: null, state: '□ ' + missing });
		},
	);
});
