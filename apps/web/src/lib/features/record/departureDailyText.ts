import type { Locale } from '#lib/i18n/index.ts';
import type { RecordCell, RecordSeries } from '#lib/server/engine.ts';
import {
	choose,
	dateRange,
	emptyRecord,
	percent,
	rateStateText,
	tally,
	timingBasis,
	withCoverage,
} from './recordText.ts';

export const dailyTitles = {
	punctuality: ['On-time share', 'Part des passages à l’heure'],
	delivery: [
		'Service delivered against scheduled',
		'Service effectué par rapport au service prévu',
	],
	periods: ['The day in five periods', 'La journée en cinq périodes'],
	lines: ['Lines to inspect', 'Lignes à examiner'],
	stops: ['Stops to inspect', 'Arrêts à examiner'],
	messages: ['Agency messages', 'Avis de l’agence'],
} as const;

export const departureTitles = {
	observed: [
		'Days observed and days with a late stop',
		'Jours observés et jours avec un arrêt en retard',
	],
	delay: ['Typical delay', 'Retard typique'],
	stops: ['Stop by stop', 'Arrêt par arrêt'],
	missed: ['Cancelled and missing departures', 'Départs annulés et manquants'],
} as const;

export function onTimeStatement(cell: RecordCell, locale: Locale) {
	if (cell.state !== 'measured') return rateStateText(cell, locale);
	const rate = cell.value.on_time;
	const { on_time, classified } = cell.evidence.counts;
	if (rate == null || on_time == null || !classified) return choose(locale, 'Unknown', 'Inconnu');
	const share = percent(rate, locale);
	const top = tally(on_time, locale);
	const total = tally(classified, locale);
	const reading = choose(
		locale,
		`${share} of observed stop events were on time (${top} of ${total})`,
		`${share} des passages observés étaient à l’heure (${top} sur ${total})`,
	);
	return `${withCoverage(reading, cell.evidence, locale)}.`;
}

export function departureDays({ cells }: RecordSeries) {
	const observed = cells.filter(({ evidence }) => (evidence.counts.classified ?? 0) > 0);
	return {
		observed: observed.length,
		late: observed.filter(({ evidence }) => (evidence.counts.late ?? 0) > 0).length,
	};
}

const periods = [
	{ start: 5, end: 7, en: 'Early morning, 5 to before 7 a.m.', fr: 'Tôt le matin, de 5 h à 7 h' },
	{
		start: 7,
		end: 10,
		en: 'Morning peak, 7 to before 10 a.m.',
		fr: 'Pointe du matin, de 7 h à 10 h',
	},
	{
		start: 10,
		end: 15,
		en: 'Midday, 10 a.m. to before 3 p.m.',
		fr: 'Milieu de journée, de 10 h à 15 h',
	},
	{
		start: 15,
		end: 19,
		en: 'Afternoon peak, 3 to before 7 p.m.',
		fr: 'Pointe de l’après-midi, de 15 h à 19 h',
	},
	{
		start: 19,
		end: 5,
		en: 'Evening and night, 7 p.m. to before 5 a.m.',
		fr: 'Soirée et nuit, de 19 h à 5 h',
	},
];

export function dailyPeriodRows(answer: RecordSeries, locale: Locale): string[][] {
	const info = answer.info?.[0];
	return periods.map(({ start, end, en, fr }) => {
		const hours = answer.cells.filter(({ key }) => {
			const hour = key.hour;
			return (
				typeof hour === 'number' &&
				(start < end ? hour >= start && hour < end : hour >= start || hour < end)
			);
		});
		const classified = hours.reduce((sum, cell) => sum + (cell.evidence.counts.classified ?? 0), 0);
		const late = hours.reduce((sum, cell) => sum + (cell.evidence.counts.late ?? 0), 0);
		// The punctuality engine has already excluded stops on lines without live data.
		const scheduledWithLive = hours.reduce(
			(sum, cell) => sum + (cell.evidence.counts.scheduled ?? 0),
			0,
		);
		const coverage = scheduledWithLive > 0 ? classified / scheduledWithLive : null;
		const state = hours.find((hour) => hour.state !== 'unknown') ?? hours[0];
		const low_coverage =
			coverage != null && info?.low_coverage_below != null && coverage < info.low_coverage_below;
		const evidence = {
			share_observed: coverage,
			low_coverage,
			counts: { scheduled: scheduledWithLive },
		};
		let reading: string;
		if (coverage != null && info?.minimum_coverage != null && coverage < info.minimum_coverage) {
			reading = withCoverage(
				choose(
					locale,
					'Not measured (insufficient coverage)',
					'Non mesuré (couverture insuffisante)',
				),
				evidence,
				locale,
			);
		} else if (!classified) {
			reading = state?.state_text[locale] ?? emptyRecord(answer.evidence, locale);
		} else if (!info || (info.minimum_coverage != null && coverage == null)) {
			reading = choose(locale, 'Unknown', 'Inconnu');
		} else if (classified < info.minimum_sample) {
			reading = choose(locale, 'Too few to judge', 'Trop peu pour juger');
		} else {
			reading = withCoverage(percent(late / classified, locale), evidence, locale);
		}
		const basisCounts = Object.fromEntries(
			['vehicle_stopped', 'trip_update_reported', 'trip_update_passed'].map((key) => [
				key,
				hours.reduce((sum, cell) => sum + (cell.evidence.counts[key] ?? 0), 0),
			]),
		);
		const basis = timingBasis(basisCounts, locale);
		return [
			choose(locale, en, fr),
			reading,
			classified
				? [`${tally(late, locale)}/${tally(classified, locale)}`, basis].filter(Boolean).join('. ')
				: reading,
		];
	});
}

export function shortDay(day: string, locale: Locale) {
	return dateRange({ from: day, to: day }, locale);
}

export function delayReading(delay: number | null | undefined, locale: Locale, fallback: string) {
	if (delay == null) return fallback;
	if (delay === 0) return choose(locale, 'On schedule', 'À l’heure prévue');
	const seconds = tally(Math.abs(delay), locale);
	return delay < 0
		? choose(locale, `${seconds} s early`, `${seconds} s d’avance`)
		: choose(locale, `${seconds} s late`, `${seconds} s de retard`);
}
