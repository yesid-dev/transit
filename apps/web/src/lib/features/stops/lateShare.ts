/**
 * The stop measure's share: late readings over readings, in tenths of a percent, rounded half
 * away from zero in exact integer arithmetic (the publisher's rounding, owner ruling 6).
 */

const isCount = (value: unknown): value is number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * Tenths of a percent for `late` of `readings`; null when the counts break their definition
 * (not whole, negative, no readings, or more late readings than readings).
 */
export function lateShareTenths(late: unknown, readings: unknown): number | null {
	if (!isCount(late) || !isCount(readings) || readings === 0 || late > readings) return null;
	const scaled = 1000n * BigInt(late);
	const total = BigInt(readings);
	const quotient = scaled / total;
	return Number(2n * (scaled - quotient * total) >= total ? quotient + 1n : quotient);
}

/** A published one-decimal share agrees with the counts' exact tenths. */
export function publishedShareAgrees(published: unknown, tenths: number): boolean {
	if (typeof published !== 'number' || !Number.isFinite(published)) return false;
	if (published < 0 || published > 100) return false;
	const scaled = published * 10;
	const rounded = Math.round(scaled);
	return Math.abs(scaled - rounded) <= 1e-6 && rounded === tenths;
}
