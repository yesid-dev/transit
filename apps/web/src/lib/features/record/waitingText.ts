import { recordPercent, minuteReading } from '#lib/site/presenter.ts';
import { type Locale } from '#lib/i18n/index.ts';
import type { RecordCell } from '#lib/server/engine.ts';
import { choose, tally } from './recordText.ts';

export const waitingMeasures = [
	['excess_wait_time', 'Excess wait time', 'Attente excédentaire'],
	['long_gaps', 'Long gaps', 'Intervalles prolongés'],
	['bunching', 'Bunching', 'Regroupement de véhicules'],
] as const;

type WaitingMeasure = (typeof waitingMeasures)[number][0];

export function waitingReading(cell: RecordCell, measure: WaitingMeasure, locale: Locale) {
	const { value, detail } = waitingReadingParts(cell, measure, locale);
	if (detail == null) return value;
	return measure === 'excess_wait_time' ? `${value} · ${detail}` : `${value} (${detail})`;
}

export function waitingReadingParts(cell: RecordCell, measure: WaitingMeasure, locale: Locale) {
	if (cell.state !== 'measured') {
		return {
			value:
				cell.evidence.coverage_reason === 'insufficient_coverage'
					? choose(
							locale,
							'Not measured (insufficient coverage)',
							'Non mesuré (couverture insuffisante)',
						)
					: cell.state_text[locale],
		};
	}

	const value = cell.value[measure];
	const { observed_headways: observed, covered_scheduled_headways: matched } = cell.evidence.counts;
	const unknown = choose(locale, 'Unknown', 'Inconnu');
	if (
		(cell.evidence.measure_states?.[measure] ?? cell.state) !== 'measured' ||
		value == null ||
		!observed
	)
		return { value: unknown };

	const total = tally(observed, locale);
	if (measure === 'excess_wait_time') {
		if (!matched) return { value: unknown };
		const duration = minuteReading(value / 60, locale);
		const scheduled = tally(matched, locale);
		return {
			value: duration,
			detail: choose(
				locale,
				`${total} observed intervals, ${scheduled} scheduled intervals in comparable windows`,
				`${total} intervalles observés, ${scheduled} intervalles prévus dans des fenêtres comparables`,
			),
		};
	}

	const count = cell.evidence.counts[measure];
	if (count == null) return { value: unknown };
	const n = tally(count, locale);
	return {
		value: recordPercent(value, locale),
		detail: choose(locale, `${n} of ${total}`, `${n} sur ${total}`),
	};
}
