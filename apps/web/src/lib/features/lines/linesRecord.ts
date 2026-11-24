import { intl, type Locale } from '#lib/i18n/index.ts';
import type { FinderCell } from '#lib/server/engine.ts';
import { createLineDirectory } from '#lib/site/lineDirectory.ts';
import { routeNameFallback } from '#lib/site/nameFallback.ts';
import { lineIsScheduleOnly } from '#lib/site/providerCapabilities.ts';
import type { PublicCity } from '#lib/v1/schemas/providers.ts';
import type { RouteIndexEntry } from '#lib/v1/schemas/routes_index.ts';
import { finderCells, finderShare, finderTrips, type FinderResult } from '../record/finderText.ts';
import { percent } from '../record/recordText.ts';
import type { RecordState } from '../record/recordStates.ts';

export const lineSortKeys = ['line', 'onTime', 'late', 'trips'] as const;
export type LineSortKey = (typeof lineSortKeys)[number];
export type LineSort = { key: LineSortKey; direction: 'asc' | 'desc' };

export function lineSort(params: URLSearchParams): LineSort {
	const key = lineSortKeys.find((key) => key === params.get('sort'));
	return {
		key: key ?? 'line',
		direction: key && params.get('direction') === 'desc' ? 'desc' : 'asc',
	};
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
	const low = percent(Math.min(...values), locale);
	const high = percent(Math.max(...values), locale);
	return low === high ? low : locale === 'fr' ? `${low} à ${high}` : `${low} to ${high}`;
}

export function lineReadingState(cell: FinderCell | undefined): RecordState {
	switch (cell?.state) {
		case 'too_few_to_judge':
		case 'no_live_data':
		case 'not_measured':
			return cell.state;
		default:
			return 'unknown';
	}
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
		const noLive =
			timing?.state === 'no_live_data' ||
			deliveryCell?.state === 'no_live_data' ||
			lineIsScheduleOnly(provider, id, directory.type(id));
		// The existing finder readings are also the source of the legacy CSV status columns.
		const onTime = finderShare(timing, punctuality, 'on_time', locale);
		const late = finderShare(timing, punctuality, 'late', locale);
		const trips = finderTrips(deliveryCell, delivery, locale);
		return {
			id,
			number: directory.number(id),
			name: directory.name(id),
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
