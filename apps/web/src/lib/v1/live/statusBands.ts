import type { StatusCode } from '../schemas';

export type DelayBandCode = Exclude<StatusCode, 'unknown'>;

/** Inclusive on-time limits from the engine's published punctuality-v3 method. */
export const ON_TIME_LIMITS_S = { from: -60, through: 300 } as const;

export function classifyDelay(delayS: number | null): StatusCode {
	if (delayS == null || !Number.isFinite(delayS)) return 'unknown';
	if (delayS < ON_TIME_LIMITS_S.from) return 'early';
	return delayS <= ON_TIME_LIMITS_S.through ? 'on_time' : 'late';
}
