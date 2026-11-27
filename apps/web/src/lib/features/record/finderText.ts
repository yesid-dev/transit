import type { Locale } from '#lib/i18n/index.ts';
import type { EngineResult, FinderCell, FinderSeries, RecordEvidence } from '#lib/server/engine.ts';
import { frameHref } from '#lib/site/frameState.ts';
import { csvCell } from '#lib/features/lines/reliability/recordCsv.ts';
import {
	choose,
	emptyRecord,
	rateStateText,
	recordConnection,
	shareReading,
	tally,
	withCoverage,
} from './recordText.ts';

export type FinderResult = EngineResult<FinderSeries>;
export type FinderReading = { text: string; value: number | null };

export function finderCells(result: FinderResult | null, key: 'line' | 'stop') {
	return new Map(
		result?.kind === 'answer'
			? result.answer.cells.flatMap((cell) => {
					const id = cell.key[key];
					return typeof id === 'string' ? [[id, cell] as const] : [];
				})
			: [],
	);
}

export function missingReading(result: FinderResult | null, locale: Locale): string {
	if (!result) return choose(locale, 'Calculating…', 'Calcul en cours…');
	return result.kind === 'answer'
		? emptyRecord(result.answer.evidence, locale)
		: recordConnection[result.kind][locale];
}

export function finderShare(
	cell: FinderCell | undefined,
	result: FinderResult | null,
	key: 'on_time' | 'late',
	locale: Locale,
): FinderReading {
	if (!cell) return { text: missingReading(result, locale), value: null };
	if (cell.state !== 'measured') return { text: rateStateText(cell, locale), value: null };
	const count = cell.evidence.counts[key];
	const sample = cell.evidence.counts.classified;
	// Both bands use the registry's classified stop-event denominator.
	const value = key === 'late' && count != null && sample ? count / sample : cell.value[key];
	return value == null
		? { text: choose(locale, 'Unknown', 'Inconnu'), value: null }
		: {
				text: shareReading({ ...cell, value: { [key]: value } }, key, locale, key === 'on_time'),
				value,
			};
}

export function finderTrips(
	cell: FinderCell | undefined,
	result: FinderResult | null,
	locale: Locale,
): FinderReading {
	if (!cell) return { text: missingReading(result, locale), value: null };
	const ran = cell.evidence.counts.ran;
	const scheduled = cell.evidence.counts.scheduled;
	if (cell.state !== 'measured') return { text: rateStateText(cell, locale), value: null };
	if (ran == null || !scheduled) return { text: choose(locale, 'Unknown', 'Inconnu'), value: null };
	return {
		text: withCoverage(
			choose(
				locale,
				`${tally(ran, locale)} of ${tally(scheduled, locale)}`,
				`${tally(ran, locale)} sur ${tally(scheduled, locale)}`,
			),
			cell.evidence,
			locale,
		),
		value: ran / scheduled,
	};
}

export function finderRecordUrl(
	url: URL,
	city: string,
	period: NonNullable<Parameters<typeof frameHref>[1]['period']>,
) {
	const pinned = new URL(frameHref(url, { mode: 'record', period }), url);
	pinned.searchParams.set('provider', city);
	return pinned;
}

export function finderCsv(
	headers: string[],
	rows: (string | number | null)[][],
	locale: Locale,
	city: string,
	period: { from: string; to: string },
	sources: RecordEvidence[],
) {
	const columns =
		locale === 'fr'
			? ['Réseau', 'Du', 'Au', 'Méthode', 'Version du nettoyage']
			: ['Network', 'From', 'To', 'Method', 'Cleaning version'];
	const evidence = [
		city,
		period.from,
		period.to,
		sources.map((source) => source.method_version).join(', '),
		[...new Set(sources.flatMap((source) => source.cleaning_versions))].join(', '),
	];
	const csv = [[...headers, ...columns], ...rows.map((row) => [...row, ...evidence])]
		.map((row) => row.map(csvCell).join(','))
		.join('\r\n');
	return 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
}
