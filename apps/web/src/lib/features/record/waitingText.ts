import { intl, type Locale } from '#lib/i18n/index.ts';
import type { RecordCell } from '#lib/server/engine.ts';
import { choose, percent, tally } from './recordText.ts';

export const waitingMeasures = [
	['excess_wait_time', 'Excess wait time', 'Attente excédentaire'],
	['long_gaps', 'Long gaps', 'Intervalles prolongés'],
	['bunching', 'Bunching', 'Regroupement de véhicules'],
] as const;

type WaitingMeasure = (typeof waitingMeasures)[number][0];

export function waitingReading(cell: RecordCell, measure: WaitingMeasure, locale: Locale) {
	if (cell.state !== 'measured') {
		return cell.evidence.coverage_reason === 'insufficient_coverage'
			? choose(
					locale,
					'Not measured (insufficient coverage)',
					'Non mesuré (couverture insuffisante)',
				)
			: cell.state_text[locale];
	}

	const value = cell.value[measure];
	const { observed_headways: observed, covered_scheduled_headways: matched } = cell.evidence.counts;
	const unknown = choose(locale, 'Unknown', 'Inconnu');
	if (
		(cell.evidence.measure_states?.[measure] ?? cell.state) !== 'measured' ||
		value == null ||
		!observed
	)
		return unknown;

	const total = tally(observed, locale);
	if (measure === 'excess_wait_time') {
		if (!matched) return unknown;
		const seconds = intl.number(locale, { maximumFractionDigits: 1 }).format(value);
		const scheduled = tally(matched, locale);
		return choose(
			locale,
			`${seconds} s · ${total} observed intervals, ${scheduled} scheduled intervals in comparable windows`,
			`${seconds} s · ${total} intervalles observés, ${scheduled} intervalles prévus dans des fenêtres comparables`,
		);
	}

	const count = cell.evidence.counts[measure];
	if (count == null) return unknown;
	const n = tally(count, locale);
	return choose(
		locale,
		`${percent(value, locale)} (${n} of ${total})`,
		`${percent(value, locale)} (${n} sur ${total})`,
	);
}
