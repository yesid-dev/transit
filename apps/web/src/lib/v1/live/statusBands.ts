import type { StatusCode } from '../schemas';

export type DelayBandCode = Exclude<StatusCode, 'unknown'>;

/** A half-open delay interval in seconds, [fromS, belowS); null leaves that side open. */
export interface DelayBand {
	readonly fromS: number | null;
	readonly belowS: number | null;
}

/**
 * The live map's status bands (methodology live-2), as the publisher classifies a vehicle's
 * predicted delay: `STATUS_BAND_CASE_SQL` in apps/db `transit_ops/snapshots/builders/_helpers.py`.
 * A vehicle with no delay is `unknown`. Record pages judge on time over a wider window; the
 * three-band switch (R4.2) replaces these codes, so a changed code fails to compile here.
 */
export const LIVE_STATUS_BANDS: Readonly<Record<DelayBandCode, DelayBand>> = {
	early: { fromS: null, belowS: -60 },
	on_time: { fromS: -60, belowS: 60 },
	late: { fromS: 60, belowS: 300 },
	severe: { fromS: 300, belowS: null },
};
