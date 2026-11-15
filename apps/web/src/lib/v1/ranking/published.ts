import type { RouteReliabilityIndex } from '#lib/v1/schemas/route_reliability_index.ts';

export function publishedWeeklyRanking(
	index: RouteReliabilityIndex | null,
	kind: 'route' | 'stop',
	now = Date.now(),
) {
	if (!index || now - Date.parse(index.generated_utc) > 86_400_000) return null;
	return (kind === 'route' ? index.weekly_routes : index.weekly_stops) ?? null;
}

export function publishedOrder<T>(
	items: readonly T[],
	id: (item: T) => string,
	order: readonly string[],
) {
	const positions = new Map(order.map((key, position) => [key, position]));
	return [...items].sort(
		(a, b) => (positions.get(id(a)) ?? Infinity) - (positions.get(id(b)) ?? Infinity),
	);
}
