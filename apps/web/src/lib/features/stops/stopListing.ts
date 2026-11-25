import { fromSearchParams } from '#lib/filters/index.ts';
import { foldSearchText, tokenMatchScore } from '#lib/search/normalize.ts';
import type { ScheduleEdition } from '#lib/search/searchIndex.ts';
import { intl, type Locale } from '#lib/i18n/index.ts';
import type { FinderCell } from '#lib/server/engine.ts';
import type { SlimStopEntry } from '#lib/v1/repositories/stopsSlim.ts';
import type { FinderResult } from '#lib/features/record/finderText.ts';

export const stopPageSize = 20;

export function stopListingView(params: URLSearchParams) {
	const query = (params.get('q') ?? '')
		.replace(/[\p{Cc}\s]+/gu, ' ')
		.trim()
		.slice(0, 80);
	const route = [...fromSearchParams(params).routes][0] ?? null;
	const requested = params.get('shown');
	const shown =
		requested && /^\d{1,6}$/u.test(requested)
			? Math.max(stopPageSize, Number(requested))
			: stopPageSize;
	return { query, route, shown };
}

/** Match only the current timetable, preserving travel order when a line is selected. */
export function listStops(schedule: ScheduleEdition, params: URLSearchParams, locale: Locale) {
	const { query, route, shown } = stopListingView(params);
	const folded = foldSearchText(query);
	const lines = new Map(schedule.routes.map((line) => [line.id, line]));
	const order = new Map<string, number>();
	for (const direction of (route && schedule.route_directions?.[route]) || []) {
		for (const stop of [...(direction.stops ?? [])].sort((a, b) => a.seq - b.seq)) {
			if (!order.has(stop.id)) order.set(stop.id, order.size);
		}
	}
	const compare = intl.collator(locale, { numeric: true, sensitivity: 'base' }).compare;
	const matching = schedule.stops.flatMap((stop) => {
		const ids = stop.routes ?? [];
		if (route && !ids.includes(route) && !order.has(stop.id)) return [];
		const lineCodes = ids.map((id) => lines.get(id)?.short ?? id);
		const lineNames = ids.map((id) => lines.get(id)?.long ?? '');
		const score = folded
			? tokenMatchScore([stop.name, stop.code, stop.id, ...lineCodes, ...lineNames], folded)
			: 0;
		return score == null ? [] : [{ stop, lineCodes, score }];
	});
	matching.sort((a, b) => {
		const direction = (order.get(a.stop.id) ?? Infinity) - (order.get(b.stop.id) ?? Infinity);
		return (
			direction ||
			a.score - b.score ||
			compare(a.stop.name, b.stop.name) ||
			compare(a.stop.id, b.stop.id)
		);
	});
	return {
		total: matching.length,
		count: schedule.stops.length,
		rows: matching.slice(0, shown).map(({ stop, lineCodes }) => ({
			id: stop.id,
			name: stop.name,
			code: stop.code,
			routeIds: stop.routes ?? [],
			lineCodes,
		})),
		lines: schedule.routes,
	};
}

export type StopListing = ReturnType<typeof listStops>;

export function stopReading(cell: FinderCell | undefined) {
	return {
		state: cell?.state,
		share: cell?.state === 'measured' ? (cell.value.on_time ?? null) : null,
		events: cell?.state === 'measured' ? (cell.evidence.counts.classified ?? null) : null,
		onTime: cell?.state === 'measured' ? (cell.evidence.counts.on_time ?? null) : null,
	};
}

export type NearbyStop = SlimStopEntry & {
	routeIds: string[];
	lineCodes: string[];
	reading?: ReturnType<typeof stopReading>;
};

export function stopListingTotals(cells: readonly FinderCell[]) {
	const counts: Record<string, number> = {};
	let observed = 0;
	let scheduled = 0;
	for (const { evidence } of cells) {
		for (const [key, count] of Object.entries(evidence.counts)) {
			if (count != null) counts[key] = (counts[key] ?? 0) + count;
		}
		const denominator = evidence.counts.scheduled ?? evidence.counts.punctuality_scheduled;
		if (denominator && evidence.share_observed != null) {
			scheduled += denominator;
			observed += denominator * evidence.share_observed;
		}
	}
	return { counts, observed: scheduled ? { share: observed / scheduled, scheduled } : null };
}

export type StopListingResult = FinderResult & { totals?: ReturnType<typeof stopListingTotals> };
