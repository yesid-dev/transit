import {
	frameDateLimit,
	MAX_RECORD_DAYS,
	RECORD_START,
	type FrameClock,
} from '#lib/site/frameState.ts';
import { getRecordAnswer, type EnginePeriod } from './engine.ts';
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
	const to = frameDateLimit(clock);
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
	const identity = await archivedIdentity('line', id, clock, scope);
	return identity === 'missing' && !schedule ? 'unconfirmed' : identity;
}

export async function vehicleIdentity(
	id: string,
	clock: FrameClock,
	scope: IdentityScope,
	tracked: boolean | undefined,
	readLive: () => Promise<CaptureSnapshot | null>,
): Promise<EntityIdentity> {
	const identity = await archivedIdentity('vehicle', id, clock, scope);
	if (identity === 'available') return identity;
	const live = tracked ? await readLive().catch(() => null) : null;
	const current =
		live &&
		captureDisplayState(captureFamily(live, 'vehicle_positions'), Date.now(), live.published_at) ===
			'live';
	const positions = current ? live.vehicle_positions : undefined;
	if (positions?.some((row) => (row.vehicle_id ?? row.id) === id)) return 'available';
	return identity === 'missing' && (tracked === false || positions) ? 'missing' : 'unconfirmed';
}
