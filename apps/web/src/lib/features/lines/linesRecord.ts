import { intl, type Locale } from '#lib/i18n/index.ts';
import type { FinderCell } from '#lib/server/engine.ts';
import { createLineDirectory } from '#lib/site/lineDirectory.ts';
import { routeNameFallback } from '#lib/site/absence.ts';
import { lineIsScheduleOnly } from '#lib/site/providerCapabilities.ts';
import type { PublicCity } from '#lib/v1/schemas/providers.ts';
import type { RouteIndexEntry } from '#lib/v1/schemas/routes_index.ts';
import { finderCells, finderShare, finderTrips, type FinderResult } from '../record/finderText.ts';
import { recordPercent } from '#lib/site/presenter.ts';
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

type Reading = { id: string; number: string } & Record<Exclude<LineSortKey, 'line'>, number | null>;

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
		if (key === 'line') return lineOrder * sign;
		const av = a[key];
		const bv = b[key];
		if (av == null) return bv == null ? lineOrder : 1;
		if (bv == null) return -1;
		return (av - bv) * sign || lineOrder;
	});
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
