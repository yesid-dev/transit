import { intl, type Locale } from '#lib/i18n/index.ts';
import type { StatusCode } from '#lib/v1/schemas/index.ts';

/** "vehicles in view now: 10 early, 157 on time"; a status nobody has is left out. */
export function inViewSentence(
	statuses: Readonly<Record<StatusCode, number>>,
	total: number,
	locale: Locale,
	lastAvailable: boolean,
): string {
	const french = locale === 'fr';
	const count = (value: number) => intl.number(locale).format(value);
	const noun = french
		? `${total === 1 ? 'véhicule' : 'véhicules'} en vue ${lastAvailable ? 'au dernier signalement' : 'en ce moment'}`
		: `${total === 1 ? 'vehicle' : 'vehicles'} in view ${lastAvailable ? 'at the last report' : 'now'}`;
	const words = french
		? {
				early: 'en avance',
				on_time: 'à l’heure',
				late: 'en retard',
				unknown: 'dont le retard est inconnu',
			}
		: { early: 'early', on_time: 'on time', late: 'late', unknown: 'with unknown delay' };
	const parts = (['early', 'on_time', 'late', 'unknown'] as const).filter(
		(status) => statuses[status] > 0,
	);
	if (!parts.length) return `${noun}.`;
	if (parts.length === 1 && statuses[parts[0]!] === total) {
		const word = words[parts[0]!];
		if (total === 1) return `${noun}, ${word}.`;
		return french
			? `${noun}\u00a0: ${parts[0] === 'unknown' ? 'retard inconnu pour tous' : `tous ${word}`}.`
			: `${noun}: all ${word}.`;
	}
	const list = parts.map((status) => `${count(statuses[status])} ${words[status]}`).join(', ');
	return french ? `${noun}\u00a0: ${list}.` : `${noun}: ${list}.`;
}
