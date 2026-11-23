import { intl, type Locale } from '#lib/i18n/index.ts';
import { causeLabel, effectLabel } from '#lib/v1/gtfsAlertLabels.ts';
import type { DateWindow } from '#lib/v1/history/window.ts';
import type { RecordCell, RecordSeries } from '#lib/server/engine.ts';
import { choose, tally } from '#lib/features/record/recordText.ts';

export const alertSections = {
	answer: { en: 'The answer', fr: 'Le résultat' },
	day: { en: 'Day by day', fr: 'Jour par jour' },
	hour: { en: 'By hour', fr: 'Par heure' },
	line: { en: 'By line', fr: 'Par ligne' },
	stop: { en: 'By stop', fr: 'Par arrêt' },
	effect: { en: 'By effect', fr: 'Par effet' },
	cause: { en: 'By cause', fr: 'Par cause' },
	messages: { en: 'Agency messages', fr: 'Avis de l’agence' },
};

export const alertMetrics = {
	alerts: { en: 'Distinct alerts', fr: 'Alertes distinctes' },
	alert_versions: { en: 'Distinct alert versions', fr: 'Versions d’alertes distinctes' },
	alert_hours: { en: 'Hours of alerts in effect', fr: 'Heures d’alerte en vigueur' },
};
const metricKeys = Object.keys(alertMetrics) as (keyof typeof alertMetrics)[];

export const alertDetailsLimit = {
	en: 'Agency messages are listed for 7 days or fewer. Pick a shorter period.',
	fr: 'Les avis de l’agence sont affichés pour 7 jours ou moins. Choisissez une période plus courte.',
};

export function alertDetailsAllowed({ from, to }: DateWindow): boolean {
	const elapsed = Date.parse(to) - Date.parse(from);
	return elapsed >= 0 && elapsed < 7 * 86_400_000;
}

export function alertReadings(cell: RecordCell, locale: Locale) {
	return metricKeys.map((id) => {
		const value = cell.value[id];
		let reading = cell.state_text[locale];
		if (cell.state === 'measured') {
			if (value == null) reading = choose(locale, 'Unknown', 'Inconnu');
			else if (id !== 'alert_hours') reading = tally(value, locale);
			else {
				const hours = intl.number(locale, { maximumFractionDigits: 2 });
				reading = value > 0 && value < 0.01 ? `< ${hours.format(0.01)}` : hours.format(value);
			}
		}
		return { id, label: alertMetrics[id][locale], reading };
	});
}

type Group = Exclude<keyof typeof alertSections, 'answer' | 'messages'>;

export function alertDay(day: string, locale: Locale) {
	return intl.dateTime(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(day));
}

export function alertRecordRows(
	series: RecordSeries,
	group: Group,
	locale: Locale,
	lineName: (id: string) => string,
) {
	const unknown = choose(locale, 'Unknown', 'Inconnu');
	return series.cells.map((cell) => {
		const key = cell.key[group];
		let label = unknown;
		if (typeof key === 'string') {
			switch (group) {
				case 'day':
					label = alertDay(key, locale);
					break;
				case 'line':
					label = lineName(key);
					break;
				case 'stop':
					label = choose(locale, `Stop ${key}`, `Arrêt ${key}`);
					break;
				case 'effect':
					label = effectLabel(key, locale) ?? unknown;
					break;
				case 'cause':
					label = causeLabel(key, locale) ?? unknown;
					break;
			}
		} else if (group === 'hour' && typeof key === 'number') {
			label = `${String(key).padStart(2, '0')}:00`;
		}
		return [label, ...alertReadings(cell, locale).map(({ reading }) => reading)];
	});
}
