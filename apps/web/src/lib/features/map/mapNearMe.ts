import type { Locale } from '#lib/i18n/index.ts';
import type { ScheduleEdition } from '#lib/search/searchIndex.ts';
import type { SlimStopEntry } from '#lib/v1/repositories/stopsSlim.ts';
import type { LatLon } from '#lib/components/map/index.ts';
import { isInsideBounds } from '#lib/geocode/types.ts';

export function parseCoordinateQuery(query: string, bbox: readonly number[]): LatLon | null {
	const match = query.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
	if (!match) return null;
	const lat = Number(match[1]);
	const lon = Number(match[2]);
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
	if (!isInsideBounds(lat, lon, bbox)) return null;
	return { lat, lon };
}

export interface NearTargetKeyInput extends LatLon {
	readonly label: string;
}

export function nearTargetKey(origin: NearTargetKeyInput): string {
	return `${origin.lat.toFixed(6)},${origin.lon.toFixed(6)}:${origin.label}`;
}

export function nearbyStopDescriptions(
	nearbyStops: readonly Pick<SlimStopEntry, 'id'>[],
	mapDirections: ScheduleEdition['route_directions'] | undefined,
	lineName: (id: string) => string,
	locale: Locale,
): ReadonlyMap<string, string> {
	const ids = new Set(nearbyStops.map(({ id }) => id));
	if (!ids.size) return new Map<string, string>();
	const lines = new Map<string, Set<string>>();
	const headsigns = new Map<string, Set<string>>();
	for (const [route, directions] of Object.entries(mapDirections ?? {})) {
		for (const { stops, headsign } of directions) {
			for (const { id } of stops ?? []) {
				if (!ids.has(id)) continue;
				if (!lines.has(id)) lines.set(id, new Set());
				lines.get(id)!.add(lineName(route));
				if (headsign) {
					if (!headsigns.has(id)) headsigns.set(id, new Set());
					headsigns.get(id)!.add(headsign);
				}
			}
		}
	}
	return new Map(
		[...lines].map(([id, codes]) => {
			const destinations = headsigns.get(id);
			const [heading] = destinations ?? [];
			return [
				id,
				destinations?.size === 1
					? (locale === 'fr' ? 'Direction' : 'Towards') + ' ' + heading
					: (locale === 'fr' ? 'Lignes' : 'Lines') + ' ' + [...codes].join(', '),
			] as const;
		}),
	);
}
