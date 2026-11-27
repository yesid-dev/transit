import type { Locale } from '#lib/i18n/index.ts';
import type { ScheduleEdition } from '#lib/search/searchIndex.ts';
import {
	directionName,
	minuteReading,
	scheduledClock,
	towardReading,
} from '#lib/site/presenter.ts';
import type { NetworkFile } from '#lib/v1/schemas/network.ts';
import type { NameSeparators } from '#lib/v1/schemas/providers.ts';

/**
 * The silent trips of the live network, each with its departure in the reader's clock and its
 * direction in the one direction form: `toward` for the "Toward" cell ("Station Laurier (Est)",
 * "East"), `heading` for a sentence ("toward Station Laurier (Est)"). `headsign` resolves a compass
 * headsign to the line's terminus (the page's line directory).
 */
export function selectSilentTripRows(
	network: Pick<NetworkFile, 'silent_trips'> | null,
	schedule: Pick<ScheduleEdition, 'routes' | 'route_directions'> | null,
	locale: Locale,
	nameSeparators?: NameSeparators,
	headsign: (line: string, sign: string) => string | undefined = (_, sign) => sign,
) {
	if (network?.silent_trips == null) return null;
	const lines = new Map(schedule?.routes.map((route) => [route.id, route.short]));
	return network.silent_trips.map((trip) => {
		const branches = schedule?.route_directions?.[trip.route_id] ?? [];
		const names = new Set(
			branches
				.filter((branch) => branch.dir === trip.direction_id)
				.map((branch) => branch.headsign?.trim())
				.filter((name) => name != null && name !== ''),
		);
		const [only] = names;
		const sign = names.size === 1 && only ? (headsign(trip.route_id, only) ?? only) : null;
		return {
			tripId: trip.trip_id,
			routeId: trip.route_id,
			line: lines.get(trip.route_id)?.trim() || trip.route_id,
			departure: scheduledClock(trip.departure.local_time, locale),
			toward: sign ? directionName(sign, locale, nameSeparators, 'cell') : null,
			heading: sign ? towardReading(sign, locale, nameSeparators, false) : null,
			silentFor: minuteReading(Math.floor(trip.silent_for_seconds / 60), locale),
		};
	});
}
