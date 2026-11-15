import { RouteReliabilityIndexSchema } from '#lib/v1/schemas/route_reliability_index.ts';

// Legacy indexes carry the publication date's midnight stamp, not its actual time.
function legacyDeadline(generated: number): number {
	const next = new Date(generated);
	const days = (3 - next.getUTCDay() + 7) % 7 || 7;
	next.setUTCDate(next.getUTCDate() + days);
	next.setUTCHours(7, 0, 0, 0);
	return next.getTime();
}

export function publishedWeeklyRanking(value: unknown, kind: 'route' | 'stop', now = Date.now()) {
	const parsed = RouteReliabilityIndexSchema.safeParse(value);
	if (!parsed.success) return null;
	const index = parsed.data;
	const generated = Date.parse(index.generated_utc);
	const published = Date.parse(index.published_utc ?? index.generated_utc);
	const deadline =
		index.next_publish_utc != null ? Date.parse(index.next_publish_utc) : legacyDeadline(published);
	if (
		![generated, published, deadline, now].every(Number.isFinite) ||
		published > now ||
		deadline <= published ||
		now >= deadline
	)
		return null;
	const rows = kind === 'route' ? index.weekly_routes : index.weekly_stops;
	return rows?.some((row) => row.state === 'ranked' && row.pct != null) ? rows : null;
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
