import {
	frameDateLimit,
	MAX_RECORD_DAYS,
	RECORD_START,
	type FrameClock,
} from '#lib/site/frameState.ts';
import { getRecordAnswer, type EnginePeriod } from './engine.ts';

export function validEntityId(id: string) {
	return Boolean(id && id.length <= 256 && id === id.trim() && !/[^\S ]|\p{C}/u.test(id));
}

const lookups = {
	line: { measure: 'on_time', group: 'line' },
	stop: { measure: 'on_time', group: 'stop_id' },
	vehicle: { measure: 'vehicle_days_in_service', group: 'vehicle' },
} as const;

export async function archivedIdentity(
	kind: keyof typeof lookups,
	id: string,
	clock: FrameClock,
	scope: Pick<EnginePeriod, 'city' | 'visitorIp'>,
) {
	const to = frameDateLimit(clock);
	const start = clock.recordStart ?? RECORD_START;
	const earliest = new Date(Date.parse(to) - (MAX_RECORD_DAYS - 1) * 86_400_000)
		.toISOString()
		.slice(0, 10);
	if (start > to) return 'unconfirmed';
	const result = await getRecordAnswer(
		{ path: '/measure', parameters: { ...lookups[kind], [kind]: id } },
		{ ...scope, from: earliest > start ? earliest : start, to },
	).catch(() => null);
	if (result?.kind !== 'answer' || !('cells' in result.answer)) return 'unconfirmed';
	if (result.answer.cells.some(({ key }) => key[kind] === id)) return 'available';
	if (result.lastGood || result.cacheStale || !result.answer.evidence.days_included.length)
		return 'unconfirmed';
	return 'missing';
}
