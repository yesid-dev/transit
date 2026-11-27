import { recordPercent } from '#lib/site/presenter.ts';
import type { Locale } from '#lib/i18n/index.ts';
import { intl } from '#lib/i18n/index.ts';
import { choose, tally } from '#lib/features/record/recordText.ts';
import type { RecordMeasure, RecordSeries } from '#lib/server/engine.ts';
import {
	hoursReading,
	liveStatusWords,
	longDate,
	recordRatio,
	serviceWeekday,
} from '#lib/site/presenter.ts';
import { addIsoDays } from '#lib/v1/history/selection.ts';
import { recordState } from '#lib/features/record/recordStates.ts';
import type { Vehicle } from '#lib/v1/schemas/index.ts';
import { STATUS_LABELS } from '#lib/v1/enumLabels.ts';

export const notTracked = {
	en: 'Vehicles are not tracked here. The feed does not provide stable vehicle numbers.',
	fr: 'Les véhicules ne sont pas suivis ici. Le flux ne fournit pas de numéros de véhicule stables.',
};

export const assignmentCaution = {
	en: 'A vehicle’s lateness mostly reflects the lines and hours it is assigned to.',
	fr: 'Le retard d’un véhicule reflète surtout les lignes et les heures qu’on lui confie.',
};

export const sectionTitles = {
	fleet: ['Days in service by vehicle', 'Jours en service par véhicule'],
	service: ['Days and hours in service', 'Jours et heures en service'],
	lines: ['Lines and trips it ran', 'Lignes et trajets effectués'],
	reporting: ['Stopped reporting', 'Interruptions de signalement'],
	completion: ['Trips it did not finish', 'Trajets non terminés'],
	punctuality: ['Its on-time record', 'Son bilan de ponctualité'],
} as const;

export function vehicleStatus(vehicle: Pick<Vehicle, 'status'>, locale: Locale) {
	return vehicle.status === 'on_time'
		? choose(locale, 'On time', 'À l’heure')
		: STATUS_LABELS[locale][vehicle.status];
}

export function vehicleHeadline(vehicle: Pick<Vehicle, 'status' | 'delay_min'>, locale: Locale) {
	const delay = vehicle.delay_min;
	if (vehicle.status === 'unknown' || delay == null)
		return { value: choose(locale, 'Delay unknown', 'Retard inconnu'), timing: null };
	const { label: value } = liveStatusWords(
		vehicle.status,
		vehicleStatus(vehicle, locale),
		delay * 60,
		locale,
	);
	if (vehicle.status !== 'on_time')
		return { value, timing: choose(locale, 'against the timetable', 'par rapport à l’horaire') };
	if (delay === 0) return { value, timing: choose(locale, 'on the timetable', 'à l’heure prévue') };
	const minutes = tally(Math.abs(delay), locale);
	return {
		value,
		timing:
			delay > 0
				? choose(locale, `${minutes} min behind the timetable`, `${minutes} min après l’horaire`)
				: choose(locale, `${minutes} min ahead of the timetable`, `${minutes} min avant l’horaire`),
	};
}

export function vehicleReading(answer: RecordMeasure, measure: string, locale: Locale): string {
	if (answer.state !== 'measured')
		return vehicleRecordState(answer.state, answer.state_text[locale], locale);
	const value = answer.value[measure];
	if (value == null) return choose(locale, 'Unknown', 'Inconnu');
	if (measure === 'vehicle_on_time') return recordPercent(value, locale);
	return intl
		.number(locale, {
			maximumFractionDigits: measure === 'vehicle_reporting_gaps_per_100_hours' ? 1 : 2,
		})
		.format(value);
}

export function vehicleRecordState(state: string | undefined, text: string, locale: Locale) {
	return state === 'not_tracked' ? notTracked[locale] : text;
}

export function vehicleLines(answer: RecordSeries) {
	return answer.cells
		.filter(({ key }) => typeof key.line === 'string')
		.sort((a, b) => (b.value.vehicle_trips_run ?? -1) - (a.value.vehicle_trips_run ?? -1));
}

export const didNotReport = {
	en: 'No report that day. That is not the same as out of service.',
	fr: 'Aucun signalement ce jour-là. Cela ne veut pas dire que le véhicule était hors service.',
};

export function vehicleDayState(cell: RecordSeries['cells'][number] | undefined) {
	const service = cell?.value.vehicle_days_in_service;
	if (cell?.state !== 'measured' || service == null) return 'not_measured';
	return service === 0 ? 'not_reporting' : 'in_service';
}

export function vehicleReportDays(
	series: RecordSeries,
	period: { from: string; to: string },
	locale: Locale,
) {
	const byDay = new Map(series.cells.map((cell) => [cell.key.day, cell]));
	// A day the network was measured and this vehicle has no row is a day it sent no report.
	const measuredDays = new Set(series.evidence.days_measured ?? series.evidence.days_included);
	const peak = Math.max(
		0,
		...series.cells.map((cell) =>
			vehicleDayState(cell) === 'in_service' ? (cell.value.vehicle_hours_in_service ?? 0) : 0,
		),
	);
	const entries = [];
	for (let day = period.from; day <= period.to; day = addIsoDays(day, 1)) {
		const cell = byDay.get(day);
		// On a day the network was measured, a missing row or an "unknown" row with no reading
		// means this vehicle sent no report, not that the day went unmeasured.
		const silent =
			!cell || (cell.state === 'unknown' && cell.value.vehicle_days_in_service == null);
		const state = silent && measuredDays.has(day) ? 'not_reporting' : vehicleDayState(cell);
		const hours = cell?.value.vehicle_hours_in_service ?? null;
		const date = longDate(day, locale);
		const report =
			state === 'not_measured'
				? null
				: state === 'not_reporting'
					? { value: recordState('not_reporting').glyph, fraction: 0 }
					: {
							value: hours == null ? recordState('unknown')[locale] : hoursReading(hours, locale),
							fraction: hours != null && peak > 0 ? hours / peak : 0,
						};
		entries.push({
			id: day,
			label: serviceWeekday(day, locale),
			dateLabel: state === 'not_reporting' ? `${date}, ${didNotReport[locale]}` : date,
			report,
			state,
		});
	}
	return entries;
}

export function vehicleServiceDays(answer: RecordMeasure, locale: Locale) {
	const active = answer.value.vehicle_days_in_service;
	const { start_date, end_date, days_included } = answer.evidence;
	const total = new Set(days_included).size;
	const selectedDays = (Date.parse(end_date) - Date.parse(start_date)) / 86_400_000 + 1;
	return {
		total,
		partial: total < selectedDays,
		ratio:
			active != null && total > 0 && active <= total
				? recordRatio(active, tally(total, locale), locale)
				: null,
	};
}
