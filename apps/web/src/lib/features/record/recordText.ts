import { intl, type Locale } from '#lib/i18n/index.ts';
import type { RecordEvidence } from '#lib/server/engine.ts';
import type { DateWindow } from '#lib/v1/history/window.ts';

export function dateRange({ from, to }: DateWindow, locale: Locale): string {
	const date = intl.dateTime(locale, { dateStyle: 'long', timeZone: 'UTC' });
	const start = new Date(from);
	const end = new Date(to);
	if (from === to) {
		const day = date.format(start);
		return locale === 'fr' ? `Le ${day}` : `On ${day}`;
	}
	const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
	const sameMonth = sameYear && start.getUTCMonth() === end.getUTCMonth();
	const monthDay = intl.dateTime(locale, { month: 'long', day: 'numeric', timeZone: 'UTC' });
	if (locale === 'fr') {
		const first = start.getUTCDate() === 1 ? '1er' : start.getUTCDate();
		const beginning = sameMonth ? first : sameYear ? monthDay.format(start) : date.format(start);
		return `Du ${beginning} au ${date.format(end)}`;
	}
	const beginning = sameYear ? monthDay.format(start) : date.format(start);
	return `From ${beginning} to ${sameMonth ? `${end.getUTCDate()}, ${end.getUTCFullYear()}` : date.format(end)}`;
}

export function percent(value: number, locale: Locale): string {
	return intl.number(locale, { style: 'percent', maximumFractionDigits: 1 }).format(value);
}

export function tally(value: number, locale: Locale): string {
	return intl.number(locale, { maximumFractionDigits: 0 }).format(value);
}

export const recordConnection = {
	unconfigured: {
		en: 'The record view is being connected. Numbers will appear here.',
		fr: 'Le bilan sera bientôt relié aux données. Les chiffres s’afficheront ici.',
	},
	unreachable: {
		en: 'The record is temporarily unavailable.',
		fr: 'Le bilan est temporairement indisponible.',
	},
	timeout: {
		en: 'The record took too long to load. Try again later.',
		fr: 'Le bilan a pris trop de temps à charger. Réessayez plus tard.',
	},
};

export function methodEvidence(
	evidence: Pick<RecordEvidence, 'method_version' | 'cleaning_versions'>,
	locale: Locale,
): string {
	const { method_version, cleaning_versions } = evidence;
	const versions = cleaning_versions.join(', ');
	if (locale === 'fr') {
		return `Méthode ${method_version}. ${
			versions
				? `Nettoyage des données, version ${versions}.`
				: 'Version du nettoyage des données inconnue.'
		}`;
	}
	return `Method ${method_version}. ${
		versions ? `Data cleaning version ${versions}.` : 'Data cleaning version unknown.'
	}`;
}
