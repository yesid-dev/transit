import { intl, type Locale } from '#lib/i18n/index.ts';
import type { FinderCell } from '#lib/server/engine.ts';
import { createLineDirectory } from '#lib/site/lineDirectory.ts';
import { routeNameFallback } from '#lib/site/absence.ts';
import { lineIsScheduleOnly } from '#lib/site/providerCapabilities.ts';
import type { PublicCity } from '#lib/v1/schemas/providers.ts';
import type { RouteIndexEntry } from '#lib/v1/schemas/routes_index.ts';
import { finderCells, finderShare, finderTrips, type FinderResult } from '../record/finderText.ts';
import { countedUnit, recordPercent } from '#lib/site/presenter.ts';
import { recordStateFor, type RecordState } from '../record/recordStates.ts';
import { lowCoverageLabel } from '../record/recordText.ts';
import { foldSearchText, tokenMatchScore } from '#lib/search/normalize.ts';

export const lineSortKeys = ['line', 'onTime', 'late', 'trips'] as const;
export type LineSortKey = (typeof lineSortKeys)[number];
export type LineSort = { key: LineSortKey; direction: 'asc' | 'desc' };

export function firstLineSort(key: LineSortKey): LineSort {
	return { key, direction: key === 'late' ? 'desc' : 'asc' };
}

export function lineSort(params: URLSearchParams): LineSort {
	const key = lineSortKeys.find((key) => key === params.get('sort'));
	const direction = params.get('direction');
	return key && (direction === 'asc' || direction === 'desc')
		? { key, direction }
		: firstLineSort(key ?? 'line');
}

/** The Lines field's text from the address, as one trimmed query. */
export function lineQuery(params: Pick<URLSearchParams, 'get'>) {
	return (params.get('q') ?? '').trim().slice(0, 80);
}

/** Whether a line matches the Lines field by its public number or its name. */
export function lineMatches(row: { number: string; label: string }, query: string) {
	if (!foldSearchText(query)) return true;
	return tokenMatchScore([row.number, row.label, `${row.number} ${row.label}`], query) !== null;
}

type Coverage = Pick<FinderCell['evidence'], 'share_observed' | 'counts'>;

export function observedLineReadings(readings: readonly Coverage[]) {
	let scheduled = 0;
	let observed = 0;
	for (const { share_observed: share, counts } of readings) {
		const events = counts.scheduled ?? counts.punctuality_scheduled;
		if (share == null || events == null || events <= 0) continue;
		scheduled += events;
		observed += share * events;
	}
	if (scheduled > 0) return { share: observed / scheduled, scheduled };
	const shares = readings.flatMap(({ share_observed }) =>
		share_observed == null ? [] : [share_observed],
	);
	return shares.length === 1 ? { share: shares[0]!, scheduled: undefined } : null;
}

type Reading = { id: string; number: string; hold?: LineHold | null } & Record<
	Exclude<LineSortKey, 'line'>,
	number | null
>;

export function orderedLines<T extends Reading>(
	rows: readonly T[],
	sort: LineSort,
	locale: Locale,
) {
	const compare = intl.collator(locale, { numeric: true, sensitivity: 'base' }).compare;
	const sign = sort.direction === 'asc' ? 1 : -1;
	const key = sort.key;
	return rows.toSorted((a, b) => {
		const lineOrder = compare(a.number, b.number) || compare(a.id, b.id);
		const aBelow = belowRankingFloor(a.hold);
		const bBelow = belowRankingFloor(b.hold);
		if (aBelow !== bBelow) return aBelow ? 1 : -1;
		if (key === 'line') return lineOrder * sign;
		if (aBelow) return lineOrder;
		const av = a[key];
		const bv = b[key];
		if (av == null) return bv == null ? lineOrder : 1;
		if (bv == null) return -1;
		return (av - bv) * sign || lineOrder;
	});
}

type LineTiming = {
	evidence: { low_coverage?: boolean; counts: Record<string, number | null> };
};

/** Why a line with an on-time share is not one Rankings would rank. */
export type LineHold =
	| { reason: 'low_coverage' }
	| { reason: 'too_few_to_judge'; unit: 'event' | 'trip-observed'; count: number; minimum: number };

export function belowRankingFloor(
	hold: LineHold | null | undefined,
): hold is Extract<LineHold, { reason: 'too_few_to_judge' }> {
	return hold?.reason === 'too_few_to_judge';
}

const floorUnits = { classified: 'event', observed_trips: 'trip-observed' } as const;

/**
 * Rankings leaves a line out when a count is under its ranking floor (too few to judge) or
 * when too few scheduled stop events were observed (low coverage). The Lines headline uses
 * the same rule. A floor whose count the answer does not carry is not applied.
 */
export function lineHold(
	timing: LineTiming | undefined,
	floors: Readonly<Record<string, number>> | undefined,
): LineHold | null {
	if (!timing) return null;
	for (const [key, minimum] of Object.entries(floors ?? {})) {
		const unit = floorUnits[key as keyof typeof floorUnits];
		const count = timing.evidence.counts[key];
		if (unit && count != null && count < minimum)
			return { reason: 'too_few_to_judge', unit, count, minimum };
	}
	return timing.evidence.low_coverage ? { reason: 'low_coverage' } : null;
}

/** Explain the ranking floor separately from the displayed reading state. */
export function lineHoldText(hold: LineHold, locale: Locale) {
	if (hold.reason === 'low_coverage') return lowCoverageLabel[locale];
	const count = countedUnit(hold.count, hold.unit, locale);
	const minimum = intl.number(locale).format(hold.minimum);
	return locale === 'fr'
		? `${count}. Il en faut ${minimum} pour classer une ligne.`
		: `${count}. A line needs ${minimum} to be ranked.`;
}

export function lineSpread(rows: readonly { onTime: number | null }[], locale: Locale) {
	const values = rows.flatMap(({ onTime }) => (onTime == null ? [] : [onTime]));
	if (!values.length) return null;
	const low = recordPercent(Math.min(...values), locale);
	const high = recordPercent(Math.max(...values), locale);
	return low === high ? low : locale === 'fr' ? `${low} à ${high}` : `${low} to ${high}`;
}

export function lineRecordRows(
	routes: readonly RouteIndexEntry[],
	provider: PublicCity | null,
	punctuality: FinderResult | null,
	delivery: FinderResult | null,
	locale: Locale,
) {
	const directory = createLineDirectory(routes, { line: (id) => routeNameFallback(id, locale) });
	const timingById = finderCells(punctuality, 'line');
	const tripsById = finderCells(delivery, 'line');
	const ids = new Set([...routes.map(({ id }) => id), ...timingById.keys(), ...tripsById.keys()]);
	const rows = Array.from(ids, (id) => {
		const timing = timingById.get(id);
		const deliveryCell = tripsById.get(id);
		const routeType = directory.type(id);
		const noLive =
			timing?.state === 'no_live_data' ||
			deliveryCell?.state === 'no_live_data' ||
			lineIsScheduleOnly(provider, id, routeType);
		// The existing finder readings are also the source of the legacy CSV status columns.
		const onTime = finderShare(timing, punctuality, 'on_time', locale);
		const late = finderShare(timing, punctuality, 'late', locale);
		const trips = finderTrips(deliveryCell, delivery, locale);
		return {
			id,
			number: directory.number(id),
			name: directory.name(id),
			routeType,
			noLive,
			onTime: onTime.value,
			late: late.value,
			trips: trips.value,
			timing,
			delivery: deliveryCell,
			csv: [
				id,
				directory.name(id).label,
				onTime.value,
				late.value,
				deliveryCell?.evidence.counts.ran ?? null,
				deliveryCell?.evidence.counts.scheduled ?? null,
				timing?.evidence.counts.classified ?? null,
				timing?.evidence.counts.on_time ?? null,
				timing?.evidence.counts.late ?? null,
				onTime.value == null ? onTime.text : '',
				trips.value == null ? trips.text : '',
			],
		};
	});
	return orderedLines(rows, { key: 'line', direction: 'asc' }, locale);
}

/**
 * The state and plain reason of a line left out of "Lines that cannot be judged".
 * The engine answers one cell per line with scheduled trips in the window, so a
 * timetable line without a cell had no trip scheduled on these dates.
 */
export function lineExclusion(
	timing: { state: string; evidence: { counts: Record<string, number | null> } } | undefined,
): {
	state: RecordState;
	text: { en: string; fr: string } | null;
} {
	if (!timing)
		return {
			state: 'not_measured',
			text: { en: 'No trip scheduled on these dates.', fr: 'Aucun trajet prévu à ces dates.' },
		};
	const state = recordStateFor(timing.state);
	if (state === 'unknown' && timing.evidence.counts.classified === 0)
		return {
			state,
			text: {
				en: 'No stop arrival on this line had a reading on these dates.',
				fr: 'Aucun passage de cette ligne n’a de relevé à ces dates.',
			},
		};
	return { state, text: null };
}
