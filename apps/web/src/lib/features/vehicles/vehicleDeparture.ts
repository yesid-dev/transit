import type { Locale } from '#lib/i18n/index.ts';
import { clockTime, serviceTime } from '#lib/site/presenter.ts';
import type { RouteFile, Trip } from '#lib/v1/schemas/index.ts';

/** Resolve this trip's published start, its timetabled first departure, or a scheduled time at a confirmed origin. */
export function vehicleDepartureTiming(
	trip: Trip | undefined,
	route: RouteFile | null | undefined,
	direction: number | null | undefined,
	locale: Locale,
	timeZone: string,
) {
	const variants = (route?.directions ?? []).filter(
		(variant) => direction == null || variant.dir === direction,
	);
	const routeStarts = variants.map(
		(variant) => variant.stops?.toSorted((a, b) => a.seq - b.seq)[0],
	);
	const routeStart = routeStarts[0];
	const origin =
		routeStart && routeStarts.every((stop) => stop?.id === routeStart.id) ? routeStart : undefined;
	const updates = trip?.scheduled_stops ?? [];
	const firstUpdate =
		updates.find(({ sequence }) => sequence === 0) ??
		updates.find((stop) => origin && stop.stop === origin.id && stop.sequence === origin.seq);
	// The timetable's first departure by trip ID, for feeds that send no start time (STM).
	const timetable = trip?.first_departure;
	const departure = timetable?.departure ?? firstUpdate?.departure;
	const scheduled = departure == null ? null : new Date(departure * 1000);
	return {
		time:
			serviceTime(trip?.start_time, locale) ??
			(scheduled && Number.isFinite(+scheduled) ? clockTime(scheduled, locale, timeZone) : null),
		origin: (timetable ? timetable.stop : firstUpdate?.stop) ?? firstUpdate?.stop ?? origin?.id,
	};
}
