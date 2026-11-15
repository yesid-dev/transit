import {
	RouteReliabilityIndexSchema,
	type RouteReliabilityIndex,
} from '#lib/v1/schemas/route_reliability_index.ts';

// Legacy indexes carry the publication date's midnight stamp, not its actual time.
function legacyDeadline(generated: number): number {
	const next = new Date(generated);
	const days = (3 - next.getUTCDay() + 7) % 7 || 7;
	next.setUTCDate(next.getUTCDate() + days);
	next.setUTCHours(7, 0, 0, 0);
	return next.getTime();
}

// .github/scripts/freshness-probe.sh: HISTORIC_TIER_MAX_AGE_SECONDS = 734400
// Its weekly ceiling is seven days plus a 36-hour completion allowance.
const COMPLETION_ALLOWANCE_MS = (734400 - 7 * 86400) * 1000;

export function weeklyPublicationDeadline(
	published: number,
	next = legacyDeadline(published),
): number {
	return next + COMPLETION_ALLOWANCE_MS;
}

type Kind = 'route' | 'stop';
type Rows = NonNullable<RouteReliabilityIndex['weekly_routes']> | null;
type Reader = (kind: Kind, now: number) => Rows;

/**
 * Whether a validated weekly index is the current publication at `now`, whatever its rows hold.
 * The one currency rule for every reader of the weekly ranking.
 */
export function weeklyIndexIsCurrent(index: RouteReliabilityIndex, now: number): boolean {
	const generated = Date.parse(index.generated_utc);
	const published = Date.parse(index.published_utc ?? index.generated_utc);
	const scheduled =
		index.next_publish_utc != null ? Date.parse(index.next_publish_utc) : legacyDeadline(published);
	const deadline = weeklyPublicationDeadline(published, scheduled);
	return (
		[generated, published, deadline].every(Number.isFinite) &&
		scheduled > published &&
		Number.isFinite(now) &&
		generated <= now &&
		published <= now &&
		now < deadline
	);
}

/** Validate once per file; the shared clock can then check availability cheaply. */
export function createPublishedWeeklyRanking(value: unknown): Reader {
	const parsed = RouteReliabilityIndexSchema.safeParse(value);
	if (!parsed.success) return () => null;
	const index = parsed.data;
	const eligible = (rows: typeof index.weekly_routes): Rows =>
		rows?.some((row) => row.state === 'ranked' && row.pct != null) ? rows : null;
	const rows = { route: eligible(index.weekly_routes), stop: eligible(index.weekly_stops) };
	return (kind, now) => (weeklyIndexIsCurrent(index, now) ? rows[kind] : null);
}

export function publishedWeeklyRanking(value: unknown, kind: Kind, now = Date.now()) {
	return createPublishedWeeklyRanking(value)(kind, now);
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
