import { intl, type Locale } from '#lib/i18n/index.ts';
import type { EngineResult, RecordAnswer, RecordCell, RecordEvidence } from '#lib/server/engine.ts';
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
	busy: {
		en: 'The record is busy right now. You can come back later.',
		fr: 'Le bilan est très sollicité en ce moment. Vous pouvez revenir plus tard.',
	},
};

export const lastGoodNote = {
	en: 'This is an older answer. The latest answer is temporarily unavailable.',
	fr: 'Ce résultat provient d’un calcul précédent. Le résultat le plus récent est temporairement indisponible.',
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

export function choose(locale: Locale, en: string, fr: string) {
	return locale === 'fr' ? fr : en;
}

export function recordMessage(result: EngineResult<RecordAnswer>, locale: Locale): string | null {
	if (result.kind !== 'answer') return recordConnection[result.kind][locale];
	const answer = result.answer;
	if ('rows' in answer) {
		if (answer.rows.length) return null;
		if (answer.state_text) return answer.state_text[locale];
		const first = answer.excluded[0];
		if (first && answer.excluded.every((entry) => entry.reason === first.reason))
			return first.reason_text[locale];
	}
	if ('cells' in answer && answer.cells.length) return null;
	if ('value' in answer) return answer.state === 'measured' ? null : answer.state_text[locale];
	return emptyRecord(answer.evidence, locale);
}

export function emptyRecord(evidence: RecordEvidence, locale: Locale) {
	return evidence.days_included.length
		? choose(locale, 'Unknown', 'Inconnu')
		: choose(locale, 'Not measured', 'Non mesuré');
}

export function punctualityBands(cell: RecordCell, locale: Locale) {
	const data = [
		['early', choose(locale, 'Early', 'En avance')],
		['on_time', choose(locale, 'On time', 'À l’heure')],
		['late', choose(locale, 'Late', 'En retard')],
	] as const;
	return data.map(([id, label]) => ({ id, label, reading: shareReading(cell, id, locale) }));
}

export function shareReading(cell: RecordCell, id: string, locale: Locale): string {
	if (cell.state !== 'measured') return cell.state_text[locale];
	const share = cell.value[id];
	const n = cell.evidence.counts[id];
	const total = cell.evidence.counts.classified;
	if (share == null || n == null || !total) return choose(locale, 'Unknown', 'Inconnu');
	return `${percent(share, locale)} (${tally(n, locale)}/${tally(total, locale)})`;
}
