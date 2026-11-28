import { MAX_RECORD_DAYS, RECORD_START, type FrameClock } from '#lib/site/frameState.ts';
import { addIsoDays } from '#lib/v1/history/selection.ts';
import { getCachedVehicleIndex, getRecordAnswer, type EnginePeriod } from './engine.ts';
import { withinBootBudget } from './timetable.ts';
import {
	captureDisplayState,
	captureFamily,
	type CaptureSnapshot,
} from '#lib/live/captureSnapshot.ts';
import type { ScheduleEdition } from '#lib/search/searchIndex.ts';

export type EntityIdentity = 'available' | 'missing' | 'unconfirmed';
export type IdentityScope = Pick<EnginePeriod, 'city' | 'visitorIp'>;

export function validEntityId(id: string) {
	return Boolean(id && id.length <= 256 && id === id.trim() && !/[^\S ]|\p{C}/u.test(id));
}

const lookups = {
	line: { measure: 'on_time', group: 'line' },
	stop: { measure: 'on_time', group: 'stop_id' },
	vehicle: { measure: 'vehicle_days_in_service', group: 'vehicle' },
} as const;

export function archivePeriod(clock: FrameClock, scope: IdentityScope): EnginePeriod | null {
	// The proxy can reuse the same settled answer until the published Record advances.
	const yesterday = addIsoDays(clock.today, -1);
	const to =
		clock.recordThrough && clock.recordThrough < yesterday ? clock.recordThrough : yesterday;
	const start = clock.recordStart ?? RECORD_START;
	const earliest = new Date(Date.parse(to) - (MAX_RECORD_DAYS - 1) * 86_400_000)
		.toISOString()
		.slice(0, 10);
	return start > to ? null : { ...scope, from: earliest > start ? earliest : start, to };
}

export async function archivedIdentity(
	kind: keyof typeof lookups,
	id: string,
	clock: FrameClock,
	scope: IdentityScope,
): Promise<EntityIdentity> {
	const period = archivePeriod(clock, scope);
	if (!period) return 'unconfirmed';
	const result = await getRecordAnswer(
		{ path: '/measure', parameters: { ...lookups[kind], [kind]: id } },
		period,
	).catch(() => null);
	if (result?.kind !== 'answer' || !('cells' in result.answer)) return 'unconfirmed';
	if (result.answer.cells.some(({ key }) => key[kind] === id)) return 'available';
	if (result.lastGood || result.cacheStale || !result.answer.evidence.days_included.length)
		return 'unconfirmed';
	return 'missing';
}

export async function lineIdentity(
	id: string,
	clock: FrameClock,
	scope: IdentityScope,
	schedule: Pick<ScheduleEdition, 'routes'> | null | undefined,
): Promise<EntityIdentity> {
	if (schedule?.routes.some((row) => row.id === id)) return 'available';
	return schedule ? archivedIdentity('line', id, clock, scope) : 'unconfirmed';
}

/** A stop in the current timetable, or one the Record still holds, as the stop page decides. */
export async function stopIdentity(
	id: string,
	clock: FrameClock,
	scope: IdentityScope,
	schedule: Pick<ScheduleEdition, 'stops'> | null | undefined,
): Promise<EntityIdentity> {
	if (schedule?.stops.some((row) => row.id === id)) return 'available';
	return schedule ? archivedIdentity('stop', id, clock, scope) : 'unconfirmed';
}

async function liveVehicleIdentity(
	id: string,
	tracked: boolean | undefined,
	readLive: () => Promise<CaptureSnapshot | null>,
): Promise<EntityIdentity> {
	if (tracked === false) return 'missing';
	const live = tracked ? await readLive().catch(() => null) : null;
	if (
		!live ||
		captureDisplayState(captureFamily(live, 'vehicle_positions'), Date.now(), live.published_at) !==
			'live' ||
		!live.vehicle_positions
	)
		return 'unconfirmed';
	return live.vehicle_positions.some((row) => (row.vehicle_id ?? row.id) === id)
		? 'available'
		: 'missing';
}

export async function vehicleIdentity(
	id: string,
	clock: FrameClock,
	scope: IdentityScope,
	tracked: boolean | undefined,
	readLive: () => Promise<CaptureSnapshot | null>,
	signal?: AbortSignal,
): Promise<EntityIdentity> {
	const started = performance.now();
	const recent = getCachedVehicleIndex(scope.city, scope.visitorIp, signal).then(
		(result): EntityIdentity => {
			if (
				result.kind !== 'answer' ||
				result.answer.vehicle_state !== 'ready' ||
				!result.answer.vehicles
			)
				return 'unconfirmed';
			if (result.answer.vehicles.some((vehicle) => vehicle.id === id)) return 'available';
			return result.lastGood || result.cacheStale ? 'unconfirmed' : 'missing';
		},
	);
	const checks = [
		withinBootBudget(liveVehicleIdentity(id, tracked, readLive), started),
		withinBootBudget(recent, started),
	] as const;
	const settled = Promise.all(checks);
	// A match can return as soon as either source settles. A miss considers both sources.
	const evidence = await Promise.race(
		checks.map(async (check) => ((await check) === 'available' ? ('available' as const) : settled)),
	);
	if (evidence === 'available' || evidence.includes('available')) return 'available';
	if (!evidence.includes('missing')) return 'unconfirmed';
	const archive = await archivedIdentity('vehicle', id, clock, scope);
	return archive === 'missing' && evidence[0] !== 'missing' ? 'unconfirmed' : archive;
}
