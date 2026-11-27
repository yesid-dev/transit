import { recordPercent, minuteReading } from '#lib/site/presenter.ts';
import { type Locale } from '#lib/i18n/index.ts';
import type { RecordCell } from '#lib/server/engine.ts';
import { choose, tally } from './recordText.ts';

export const waitingMeasures = [
	['excess_wait_time', 'Excess wait time', 'Attente excédentaire'],
	['long_gaps', 'Long gaps', 'Intervalles prolongés'],
	['bunching', 'Bunching', 'Véhicules trop rapprochés'],
] as const;

type WaitingMeasure = (typeof waitingMeasures)[number][0];

export function waitingReading(cell: RecordCell, measure: WaitingMeasure, locale: Locale) {
	const { value, detail } = waitingReadingParts(cell, measure, locale);
	if (detail == null) return value;
	return `${value} (${detail})`;
}

export function waitingReadingParts(cell: RecordCell, measure: WaitingMeasure, locale: Locale) {
	if (cell.state !== 'measured') {
		return {
			value:
				cell.evidence.coverage_reason === 'insufficient_coverage'
					? choose(
							locale,
							'Not measured: too little observed',
							'Non mesuré\u00a0: trop peu observé',
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

	if (measure === 'excess_wait_time') {
		const duration = matched ? minuteReading(value / 60, locale) : null;
		return duration == null ? { value: unknown } : { value: duration, measured: true };
	}

	const count = cell.evidence.counts[measure];
	if (count == null) return { value: unknown };
	const n = tally(count, locale);
	const total = tally(observed, locale);
	return {
		value: recordPercent(value, locale),
		detail: choose(locale, `${n} of ${total}`, `${n} sur ${total}`),
	};
}
