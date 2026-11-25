import type {
	BandBarProps,
	ChartPoint,
	ChartTick,
	HourGridCell,
	HourGridProps,
	RangeMarkProps,
	StopLadderProps,
	StopLadderStop,
} from '@yesid/ui/chart';
import { scaleLinear } from 'd3-scale';
import { intl, type Locale } from '#lib/i18n/index.ts';
import { transitTerms } from '#lib/i18n/transitTerms.copy.ts';
import type { DelayDistribution, RecordCell, RecordSeries } from '#lib/server/engine.ts';
import {
	countedUnit,
	dateRange,
	delayRange,
	delayReading,
	sampleWithMinimum,
} from '#lib/site/presenter.ts';
import { choose, measuredShare, percent, tally } from '../recordText.ts';
import { recordState, type RecordState } from '../recordStates.ts';

export type ChartTable = {
	columns: { label: string; value: string; detail?: string };
	rows: { id: string; label: string; value: string; detail?: string }[];
	pageSize?: number;
};

type ChartReading<Props> = { props: Props; table: ChartTable };
type SeriesCell = RecordSeries['cells'][number];

export function chartState(state?: RecordCell['state']): RecordState {
	switch (state) {
		case 'no_live_data':
		case 'not_measured':
		case 'too_few_to_judge':
		case 'not_tracked':
		case 'unknown':
			return state;
		default:
			return state === undefined ? 'not_measured' : 'unknown';
	}
}

export function bandChart(
	cell: RecordCell,
	title: string,
	locale: Locale,
): ChartReading<BandBarProps> {
	const { band } = transitTerms[locale];
	const bands = (
		[
			['early', band.early],
			['on_time', band.onTime],
			['late', band.late],
		] as const
	).flatMap(([id, label]) => {
		const share = measuredShare(cell, id);
		const count = cell.evidence.counts[id];
		return share == null || count == null
			? []
			: [
					{
						id,
						label,
						share,
						status: id,
						valueLabel: percent(share, locale),
						detail: countedUnit(count, 'event', locale),
					},
				];
	});
	return {
		props: {
			label:
				bands
					.map(({ label, valueLabel, detail }) => `${label}: ${valueLabel}, ${detail}`)
					.join('. ') || title,
			bands,
		},
		table: {
			columns: {
				label: choose(locale, 'Status', 'État'),
				value: choose(locale, 'Share', 'Part'),
				detail: choose(locale, 'Stop events', 'Passages aux arrêts'),
			},
			rows: bands.map(({ id, label, valueLabel, detail }) => ({
				id,
				label,
				value: valueLabel,
				detail,
			})),
		},
	};
}

const hourLevels = [0.1, 0.15, 0.2, 0.25] as const;

export function histogramChart(
	answer: {
		state: DelayDistribution['state'];
		cells: Pick<DelayDistribution['cells'][number], 'key' | 'value'>[];
	},
	title: string,
	locale: Locale,
) {
	const bins = answer.state === 'measured' ? answer.cells : [];
	const points = bins.map(({ key: { min_seconds, max_seconds }, value }) => ({
		x: min_seconds === null ? (max_seconds! + 1) / 60 - 0.5 : Math.floor(min_seconds / 60) + 0.5,
		y: value.delay_distribution,
	}));
	const xDomain = [(points[0]?.x ?? 0) - 0.5, (points.at(-1)?.x ?? 0) + 0.5] as const;
	const y = scaleLinear()
		.domain([0, Math.max(0.01, ...points.map(({ y }) => y))])
		.nice(4);
	const yDomain = [0, y.domain()[1]] as const;
	const axis = choose(locale, 'Minutes against the timetable', 'Minutes par rapport à l’horaire');
	const { band } = transitTerms[locale];
	const table: ChartTable = {
		columns: {
			label: choose(locale, 'Minute range', 'Tranche de minutes'),
			value: choose(locale, 'Stop events', 'Passages aux arrêts'),
			detail: choose(locale, 'Share', 'Part'),
		},
		rows: bins.map(({ key, value }) => ({
			id: String(key.min_seconds),
			label: delayRange(key.min_seconds, key.max_seconds, locale),
			value: tally(value.stop_events, locale),
			detail: percent(value.delay_distribution, locale),
		})),
	};
	return {
		props: {
			label: `${title}. ${choose(
				locale,
				'Share of observed stop events by minutes against the timetable.',
				'Part des passages observés aux arrêts selon l’écart à l’horaire en minutes.',
			)}`,
			axis,
			xDomain,
			yDomain,
			points,
			ticks: [-1, 0, 5, 10].map((value) => ({
				value,
				label: value > 0 ? `+${value}` : String(value),
			})),
			yTicks: y.ticks(4).map((value) => ({ value, label: percent(value, locale) })),
			boundaries: [-1, 5],
			bands: [
				{ status: 'early', label: band.early },
				{ status: 'on_time', label: band.onTime },
				{ status: 'late', label: band.late },
			] as const,
		},
		table,
	};
}

export function minimumSample(series: RecordSeries, measure: string) {
	return (
		series.info?.find((info) => info.id === measure)?.minimum_sample ??
		(series.info?.length === 1 ? series.info[0].minimum_sample : undefined)
	);
}

function serviceHours(series: RecordSeries) {
	const active = [
		...new Set(
			series.cells.flatMap((cell) => {
				const { hour } = cell.key;
				const { counts, excluded } = cell.evidence;
				const hasService =
					(counts.scheduled ?? 0) > 0 ||
					(counts.classified ?? 0) > 0 ||
					(excluded?.route_without_live_data ?? 0) > 0 ||
					cell.state === 'no_live_data';
				return hasService &&
					typeof hour === 'number' &&
					Number.isInteger(hour) &&
					hour >= 0 &&
					hour < 24
					? [hour]
					: [];
			}),
		),
	].sort((a, b) => a - b);
	if (!active.length) return [];

	// The longest gap between active hours identifies the overnight break.
	// In a tie, keep the earliest start so equivalent schedules do not jump.
	let start = active[0];
	let length = 0;
	let largestGap = 0;
	for (const [index, hour] of active.entries()) {
		const previous = active[(index + active.length - 1) % active.length];
		const gap = ((hour - previous + 23) % 24) + 1;
		if (gap <= largestGap) continue;
		start = hour;
		length = 25 - gap;
		largestGap = gap;
	}
	return Array.from({ length }, (_, offset) => (start + offset) % 24);
}

export function hourChart(
	series: RecordSeries,
	title: string,
	locale: Locale,
): ChartReading<HourGridProps> {
	const minimum = minimumSample(series, 'late');
	const few = recordState('too_few_to_judge')[locale];
	const none = choose(locale, 'No service at that hour', 'Aucun service à cette heure');
	const stateLabels = {
		few:
			choose(locale, 'few: too few to judge', 'peu : trop peu de données pour conclure') +
			(minimum == null
				? ''
				: choose(
						locale,
						`, under ${countedUnit(minimum, 'event', locale)}`,
						`, moins de ${countedUnit(minimum, 'event', locale)}`,
					)),
		none: choose(locale, 'none: no service at that hour', 'aucun : aucun service à cette heure'),
		unmeasured: recordState('not_measured')[locale],
	};
	const cells = new Map(series.cells.map((cell) => [`${cell.key.weekday}/${cell.key.hour}`, cell]));
	const columns = serviceHours(series).map((hour) => ({
		id: String(hour),
		label: choose(locale, `${String(hour).padStart(2, '0')}h`, `${hour} h`),
	}));
	const tableRows: ChartTable['rows'] = [];
	const rows = Array.from({ length: 7 }, (_, index) => {
		const id = String(index + 1);
		const monday = new Date(Date.UTC(2024, 0, index + 1));
		const weekday = (width: 'short' | 'long') =>
			intl.dateTime(locale, { weekday: width, timeZone: 'UTC' }).format(monday);
		const day = weekday('long');
		return {
			id,
			label: weekday('short'),
			cells: columns.map(({ id: hour, label }): HourGridCell => {
				const reading = cells.get(`${id}/${hour}`);
				const counts = reading?.evidence.counts;
				const value = measuredShare(reading, 'late');
				const context = `${day}, ${label}`;
				const count = counts?.classified;
				const detail = count == null ? undefined : countedUnit(count, 'event', locale);
				const separator = choose(locale, ': ', ' : ');
				if (value !== null) {
					const share = percent(value, locale);
					const status = choose(locale, `${share} late`, `${share} en retard`);
					tableRows.push({ id: context, label: context, value: share, detail });
					return {
						text: tally(value * 100, locale),
						level: hourLevels.filter((floor) => value >= floor).length as NonNullable<
							HourGridCell['level']
						>,
						name: [context + separator + status, detail].filter(Boolean).join(', '),
					};
				}
				const tooFew = reading?.state === 'too_few_to_judge';
				const noService =
					reading?.state === 'unknown' &&
					counts?.scheduled === 0 &&
					!reading.evidence.excluded?.route_without_live_data;
				const state = tooFew ? 'few' : noService ? 'none' : 'unmeasured';
				const status =
					state === 'unmeasured'
						? recordState(chartState(reading?.state))[locale]
						: tooFew
							? few
							: none;
				const text = tooFew
					? choose(locale, 'few', 'peu')
					: noService
						? choose(locale, 'none', 'aucun')
						: '□';
				tableRows.push({
					id: context,
					label: context,
					value: status,
					detail: tooFew ? detail : undefined,
				});
				return {
					text,
					level: null,
					state,
					name:
						context +
						separator +
						status.toLocaleLowerCase(locale) +
						(tooFew && detail ? ` (${detail})` : ''),
				};
			}),
		};
	});
	const shownStates = new Set(rows.flatMap(({ cells }) => cells.map(({ state }) => state)));
	return {
		props: {
			label: title,
			rows,
			columns,
			stateLabels: {
				few: shownStates.has('few') ? stateLabels.few : '',
				none: shownStates.has('none') ? stateLabels.none : '',
				unmeasured: shownStates.has('unmeasured') ? stateLabels.unmeasured : '',
			},
			scale: {
				label: choose(locale, 'Late share, in percent:', 'Part en retard, en pourcentage :'),
				steps:
					locale === 'fr'
						? ['moins de 10', '10 à 15', '15 à 20', '20 à 25', '25 et plus']
						: ['under 10', '10 to 15', '15 to 20', '20 to 25', '25 and over'],
			},
		},
		table: {
			columns: {
				label: choose(locale, 'Weekday and hour', 'Jour et heure'),
				value: choose(locale, 'Late share', 'Part en retard'),
				detail: choose(locale, 'Stop events', 'Passages aux arrêts'),
			},
			rows: tableRows,
			pageSize: 12,
		},
	};
}

type TrendProps = {
	label: string;
	points: ChartPoint[];
	reference: ChartPoint[];
	ticks: ChartTick[];
	yTicks: ChartTick[];
	xDomain: [number, number];
	yDomain: [number, number];
	last?: { x: number; y: number; label: string };
};

export function trendChart(
	series: RecordSeries,
	title: string,
	locale: Locale,
	network?: RecordSeries,
): ChartReading<TrendProps> {
	const keyed = (cells: SeriesCell[]) =>
		new Map(
			cells.flatMap((cell) =>
				typeof cell.key.day === 'string' ? [[cell.key.day, cell] as const] : [],
			),
		);
	const daily = keyed(series.cells);
	const referenceDaily = keyed(network?.cells ?? []);
	const dates = [...new Set([...daily.keys(), ...series.evidence.days_not_measured])].sort();
	const points = dates.map((day, x) => ({ x, y: measuredShare(daily.get(day), 'on_time') }));
	const reference = network
		? dates.map((day, x) => ({ x, y: measuredShare(referenceDaily.get(day), 'on_time') }))
		: [];
	const label = (day: string, options: Intl.DateTimeFormatOptions) =>
		intl.dateTime(locale, { ...options, timeZone: 'UTC' }).format(new Date(day));
	const reading = (value: number | null, cell?: SeriesCell) =>
		value === null ? recordState(chartState(cell?.state))[locale] : percent(value, locale);
	const rows = dates.map((day, index) => ({
		id: day,
		label: label(day, { dateStyle: 'long' }),
		value: reading(points[index].y, daily.get(day)),
		detail: network ? reading(reference[index].y, referenceDaily.get(day)) : undefined,
	}));
	const values = [...points, ...reference].flatMap(({ y }) => (y === null ? [] : [y]));
	const low = Math.min(...values, 1);
	const high = Math.max(...values, 0);
	const span = (high - low) * 100;
	const step = span > 60 ? 25 : span > 30 ? 20 : span > 15 ? 10 : 5;
	let start = Math.max(0, Math.floor((low * 100 + 1e-9) / step) * step);
	let end = Math.min(100, Math.ceil((high * 100 - 1e-9) / step) * step);
	if (end <= start) {
		start = Math.max(0, end - step);
		end = Math.min(100, end + step);
	}
	const last = points.findLast((point): point is { x: number; y: number } => point.y !== null);
	const networkLabel = network ? choose(locale, 'Network', 'Réseau') : undefined;
	return {
		props: {
			label: [
				title,
				...rows.map(
					(row) =>
						`${row.label}: ${row.value}${networkLabel ? `, ${networkLabel} ${row.detail}` : ''}`,
				),
			].join('. '),
			points,
			reference,
			ticks: dates.flatMap((day, index) =>
				index === 0 || index === dates.length - 1
					? [
							{
								value: index,
								label: dateRange({ from: day, to: day }, locale).replace(/ \d{4}$/u, ''),
							},
						]
					: [],
			),
			yDomain: values.length ? [start / 100, end / 100] : [0, 1],
			yTicks: Array.from(
				{ length: Math.max(0, Math.floor((end - start) / step) + 1) },
				(_, index) => {
					const value = (start + index * step) / 100;
					return { value, label: percent(value, locale) };
				},
			),
			last: last ? { ...last, label: percent(last.y, locale) } : undefined,
			xDomain: [-0.5, Math.max(0.5, dates.length - 0.5)],
		},
		table: {
			columns: {
				label: choose(locale, 'Service date', 'Date de service'),
				value: choose(locale, 'On-time share', 'Part à l’heure'),
				detail: networkLabel,
			},
			rows,
			pageSize: 12,
		},
	};
}

export function rangeChart(
	reading: { value: number; range: { lower: number; upper: number } },
	title: string,
	locale: Locale,
	network?: number,
): ChartReading<RangeMarkProps> {
	const {
		value,
		range: { lower: low, upper: high },
	} = reading;
	const interval = choose(
		locale,
		`${percent(low, locale)} to ${percent(high, locale)}`,
		`${percent(low, locale)} à ${percent(high, locale)}`,
	);
	const comparison =
		network == null
			? undefined
			: choose(
					locale,
					`network at ${percent(network, locale)}`,
					`réseau à ${percent(network, locale)}`,
				);
	const figure = percent(value, locale);
	return {
		props: {
			low,
			high,
			value,
			domain: [0, 1],
			label: `${title}: ${figure}, ${interval}${comparison ? `; ${comparison}` : ''}.`,
			caption: interval,
			reference: network != null && comparison ? { value: network, label: comparison } : undefined,
		},
		table: {
			columns: {
				label: title,
				value: transitTerms[locale].reading,
				detail: transitTerms[locale].uncertaintyRange,
			},
			rows: [
				{
					id: title,
					label: title,
					value: figure,
					detail: comparison ? `${interval}, ${comparison}` : interval,
				},
			],
		},
	};
}

export function stopLadderChart(
	series: RecordSeries,
	title: string,
	locale: Locale,
	stop: (id: string) => Pick<StopLadderStop, 'name' | 'code' | 'href' | 'timingPoint'>,
	observed = false,
): ChartReading<StopLadderProps> {
	const stops = series.cells.flatMap((cell, index) => {
		if (typeof cell.key.stop !== 'string') return [];
		const median = cell.state === 'measured' ? (cell.value.median_delay ?? null) : null;
		const value = observed ? (cell.evidence.observed_delay_seconds ?? median) : median;
		const mark = recordState(chartState(cell.state));
		const minimum = minimumSample(series, 'punctuality');
		const count = cell.evidence.counts.classified;
		const sample =
			observed && cell.state === 'too_few_to_judge' && count != null && minimum != null
				? sampleWithMinimum(countedUnit(count, 'event', locale), minimum, locale)
				: null;
		const state =
			value === null
				? [observed ? `${mark.glyph} ${mark[locale]}` : mark[locale], sample]
						.filter(Boolean)
						.join(' · ')
				: undefined;
		return [
			{
				...stop(cell.key.stop),
				id: `${cell.key.stop}/${index}`,
				value,
				valueLabel: state ?? delayReading(value, locale),
				state,
			},
		];
	});
	const columns = {
		stop: observed ? '' : choose(locale, 'Stop', 'Arrêt'),
		value: observed
			? choose(locale, 'Delay', 'Retard')
			: choose(locale, 'Median delay', 'Retard médian'),
	};
	return {
		props: {
			label: title,
			columns,
			stops,
			max: Math.max(observed ? 360 : 1, ...stops.map(({ value }) => value ?? 0)),
			threshold: observed
				? { value: 300, label: choose(locale, 'Late beyond 5 min', 'En retard au-delà de 5 min') }
				: undefined,
		},
		table: {
			columns: { label: choose(locale, 'Stop', 'Arrêt'), value: columns.value },
			rows: stops.map(({ id, name, valueLabel }) => ({ id, label: name, value: valueLabel })),
			pageSize: 12,
		},
	};
}
