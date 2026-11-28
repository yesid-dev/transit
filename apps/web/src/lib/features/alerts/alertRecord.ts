import { intl, type Locale } from '#lib/i18n/index.ts';
import type { RecordCell } from '#lib/server/engine.ts';
import { choose, tally } from '#lib/features/record/recordText.ts';

export const alertSections = {
	answer: { en: 'The answer', fr: 'Le résultat' },
	day: { en: 'Day by day', fr: 'Jour par jour' },
	hour: { en: 'By hour', fr: 'Par heure' },
	line: { en: 'By line', fr: 'Par ligne' },
	stop: { en: 'By stop', fr: 'Par arrêt' },
	effect: { en: 'By effect', fr: 'Par effet' },
	cause: { en: 'By cause', fr: 'Par cause' },
	messages: { en: 'Service alerts', fr: 'Avis de service' },
};

export const alertMetrics = {
	alerts: { en: 'Notices', fr: 'Avis' },
	alert_versions: { en: 'Distinct notice versions', fr: 'Versions d’avis distinctes' },
	alert_hours: { en: 'Hours of notices in effect', fr: 'Heures d’avis en vigueur' },
};
const metricKeys = Object.keys(alertMetrics) as (keyof typeof alertMetrics)[];

export const alertDetailsLimit = {
	en: 'To see the notices, choose a period of 7 days or fewer.',
	fr: 'Pour voir les avis, choisissez une période de 7 jours ou moins.',
};

export { alertDetailsAllowed } from './alertDetailsAllowed.ts';

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
