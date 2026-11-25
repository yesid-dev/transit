import type { Locale } from '#lib/i18n/index.ts';
import type { ScheduleEdition } from '#lib/search/searchIndex.ts';
import { directionName, minuteReading } from '#lib/site/presenter.ts';
import type { NetworkFile } from '#lib/v1/schemas/network.ts';
import type { NameSeparators } from '#lib/v1/schemas/providers.ts';

export function selectSilentTripRows(
	network: Pick<NetworkFile, 'silent_trips'> | null,
	schedule: Pick<ScheduleEdition, 'routes' | 'route_directions'> | null,
	locale: Locale,
	nameSeparators?: NameSeparators,
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
		const [toward] = names;
		return {
			tripId: trip.trip_id,
			routeId: trip.route_id,
			line: lines.get(trip.route_id)?.trim() || trip.route_id,
			departure: trip.departure.local_time,
			toward: names.size === 1 ? directionName(toward, locale, nameSeparators) : null,
			silentFor: minuteReading(trip.silent_for_seconds / 60, locale),
		};
	});
}
