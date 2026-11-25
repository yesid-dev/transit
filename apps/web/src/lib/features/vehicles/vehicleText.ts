import type { Locale } from '#lib/i18n/index.ts';
import { intl } from '#lib/i18n/index.ts';
import { choose, percent, tally } from '#lib/features/record/recordText.ts';
import type { RecordMeasure, RecordSeries } from '#lib/server/engine.ts';
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
	const status = vehicleStatus(vehicle, locale);
	const delay = vehicle.delay_min;
	if (delay == null || delay === 0) return status;
	const minutes = tally(Math.abs(delay), locale);
	const detail =
		delay > 0
			? choose(locale, `${minutes} min behind the timetable`, `${minutes} min après l’heure prévue`)
			: choose(
					locale,
					`${minutes} min ahead of the timetable`,
					`${minutes} min avant l’heure prévue`,
				);
	return `${status}, ${detail}`;
}

export function vehicleReading(answer: RecordMeasure, measure: string, locale: Locale): string {
	if (answer.state !== 'measured')
		return vehicleRecordState(answer.state, answer.state_text[locale], locale);
	const value = answer.value[measure];
	if (value == null) return choose(locale, 'Unknown', 'Inconnu');
	if (measure === 'vehicle_on_time') return percent(value, locale);
	return intl.number(locale, { maximumFractionDigits: 2 }).format(value);
}

export function vehicleRecordState(state: string | undefined, text: string, locale: Locale) {
	return state === 'not_tracked' ? notTracked[locale] : text;
}

export function vehicleLines(answer: RecordSeries) {
	return answer.cells
		.filter(({ key }) => typeof key.line === 'string')
		.sort((a, b) => (b.value.vehicle_trips_run ?? -1) - (a.value.vehicle_trips_run ?? -1));
}
