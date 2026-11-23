import { intl, type Locale } from '#lib/i18n/index.ts';
import {
	choose,
	dateRange,
	lastGoodNote,
	methodEvidence,
	percent,
	rateStateText,
	withCoverage,
	tally,
} from '#lib/features/record/recordText.ts';
import type { RecordAnswer, RecordMeasure } from '#lib/server/engine.ts';
import type { StopSection } from '#lib/server/stopRecord.ts';

export const stopSectionTitles = {
	punctuality: ['On-time performance', 'Ponctualité'],
	byLine: ['By line', 'Par ligne'],
	hourly: ['By hour', 'Par heure'],
	daily: ['Day by day', 'Jour par jour'],
	delay: ['Typical delay', 'Retard typique'],
	accessibility: ['Wheelchair boarding', 'Embarquement en fauteuil roulant'],
	alerts: ['Alerts for this stop', 'Avis pour cet arrêt'],
} satisfies Record<StopSection, [string, string]>;

export function stopAnswer(answer: RecordMeasure, locale: Locale): string {
	if (answer.state !== 'measured') return rateStateText(answer, locale);
	const share = answer.value.on_time;
	const { on_time, classified } = answer.evidence.counts;
	if (share == null || on_time == null || !classified) return choose(locale, 'Unknown', 'Inconnu');
	const dates = dateRange(
		{ from: answer.evidence.start_date, to: answer.evidence.end_date },
		locale,
	);
	const value = percent(share, locale);
	const onTime = tally(on_time, locale);
	const total = tally(classified, locale);
	const reading = choose(
		locale,
		`${dates}, ${value} of observed stop events here were on time (${onTime} of ${total})`,
		`${dates}, ${value} des passages observés à cet arrêt étaient à l’heure (${onTime} sur ${total})`,
	);
	return `${withCoverage(reading, answer.evidence, locale)}.`;
}

export function stopDelay(seconds: number | null | undefined, locale: Locale): string {
	if (seconds == null) return choose(locale, 'Unknown', 'Inconnu');
	const value = intl.number(locale, { maximumFractionDigits: 1 }).format(Math.abs(seconds));
	if (seconds < 0) return choose(locale, `${value} s early`, `${value} s d’avance`);
	if (seconds > 0) return choose(locale, `${value} s late`, `${value} s de retard`);
	return `${value} s`;
}

export const stopAccessibilityDescription = {
	en: 'This is what the agency declared for this stop in the schedule on its latest service date in the selection.',
	fr: 'Il s’agit de la déclaration de l’exploitant dans l’horaire pour cet arrêt à sa dernière date de service dans la période choisie.',
};

export function stopAccessibility(answer: RecordMeasure, locale: Locale): string {
	if (answer.state !== 'measured') return answer.state_text[locale];
	const { stops_accessible, stops_not_accessible, stops_no_information } = answer.evidence.counts;
	if (stops_no_information === 1) return choose(locale, 'No information', 'Aucune information');
	if (stops_accessible === 1) return choose(locale, 'Accessible', 'Accessible');
	if (stops_not_accessible === 1) return choose(locale, 'Not accessible', 'Non accessible');
	return choose(locale, 'Unknown', 'Inconnu');
}

export function stopCitation(
	subject: string,
	section: StopSection,
	answer: RecordAnswer,
	locale: Locale,
	href: string,
	lastGood?: true,
): string {
	const { evidence } = answer;
	const dates = dateRange({ from: evidence.start_date, to: evidence.end_date }, locale);
	return [
		`Transit · ${subject}. ${choose(locale, ...stopSectionTitles[section])}. ${dates}.`,
		section === 'punctuality' && 'value' in answer ? stopAnswer(answer, locale) : '',
		section === 'accessibility' && 'value' in answer
			? `${stopAccessibilityDescription[locale]} ${stopAccessibility(answer, locale)}.`
			: '',
		methodEvidence(evidence, locale),
		lastGood ? lastGoodNote[locale] : '',
		href,
	]
		.filter(Boolean)
		.join(' ');
}
