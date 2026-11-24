import type { StatusCode } from '../schemas';

export type DelayBandCode = Exclude<StatusCode, 'unknown'>;

/** A half-open delay interval in seconds, [fromS, belowS); null leaves that side open. */
export interface DelayBand {
	readonly fromS: number | null;
	readonly belowS: number | null;
}

// These bounds match the engine's published punctuality method.
const earlyLimitS = -60;
const lateLimitS = 300;

export const LIVE_STATUS_BANDS: Readonly<Record<DelayBandCode, DelayBand>> = {
	early: { fromS: null, belowS: earlyLimitS },
	on_time: { fromS: earlyLimitS, belowS: lateLimitS },
	late: { fromS: lateLimitS, belowS: null },
};

export function classifyDelay(delayS: number | null): StatusCode {
	if (delayS == null || !Number.isFinite(delayS)) return 'unknown';
	if (delayS < earlyLimitS) return 'early';
	return delayS < lateLimitS ? 'on_time' : 'late';
}
