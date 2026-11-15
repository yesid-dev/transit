/** A late-share interval in percent, lower <= upper, both in [0, 100]. */
export interface LateShareInterval {
	readonly lower: number;
	readonly upper: number;
}

const tenth = (value: number): number => Math.round(value * 10) / 10 + 0;

/**
 * The page's only conversion of the published bounds. The publisher's Wilson bounds describe
 * the share of readings NOT more than 5 minutes late, so the late share's interval is their
 * complement: [100 − hi, 100 − lo]. Callers pass bounds already checked to lie in [0, 100]
 * with lo <= hi; an absent bound means no interval.
 */
export function lateShareInterval(
	onTimeLower: number | null | undefined,
	onTimeUpper: number | null | undefined,
): LateShareInterval | null {
	if (onTimeLower == null || onTimeUpper == null) return null;
	return { lower: tenth(100 - onTimeUpper), upper: tenth(100 - onTimeLower) };
}
