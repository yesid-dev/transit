import type { RouteFile } from '#lib/v1/schemas/index.ts';

export type VehicleMapStop = { id: string; name: string; lat: number; lon: number };

/** The preview draws a single published variant when the live trip identifies one. */
export function vehicleLocationRoute(
	route: RouteFile | null | undefined,
	direction: number | null | undefined,
	headSign: string | null | undefined,
	nextStop: string | null | undefined,
): RouteFile | null {
	if (!route) return null;
	let candidates = (route.directions ?? []).filter(
		({ dir, shape }) =>
			(direction == null || dir === direction) &&
			shape?.type === 'LineString' &&
			Array.isArray(shape.coordinates) &&
			shape.coordinates.length >= 2,
	);
	if (nextStop) {
		const servingNext = candidates.filter(({ stops }) => stops?.some(({ id }) => id === nextStop));
		if (servingNext.length) candidates = servingNext;
	}
	if (headSign && candidates.length > 1) {
		const matching = candidates.filter(({ headsign }) => headsign === headSign);
		if (matching.length) candidates = matching;
	}
	return candidates.length === 1 ? { ...route, directions: candidates } : null;
}
