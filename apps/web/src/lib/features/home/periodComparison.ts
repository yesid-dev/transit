import { addIsoDays } from '#lib/v1/history/selection.ts';
import type { DateWindow } from '#lib/v1/history/window.ts';

const Z_95 = 1.959963984540054;
const DAY_MS = 86_400_000;

type Sample = { onTime: number; observed: number };
type PeriodSample = Sample & { measuredDays: number; days: number; observedShare: number };

export function periodDays(from: string, to: string) {
	return (Date.parse(to) - Date.parse(from)) / DAY_MS + 1;
}

export function wilsonBounds({ onTime, observed }: Sample) {
	const share = onTime / observed;
	const adjustment = Z_95 ** 2 / observed;
	const center = (share + adjustment / 2) / (1 + adjustment);
	const radius =
		(Math.sqrt((share * (1 - share)) / observed + adjustment / (4 * observed)) * Z_95) /
		(1 + adjustment);
	return {
		lower: onTime === 0 ? 0 : center - radius,
		upper: onTime === observed ? 1 : center + radius,
	};
}

// Newcombe (1998), method 10, combining uncorrected Wilson score intervals.
export function newcombeDifference(current: Sample, previous: Sample) {
	const now = current.onTime / current.observed;
	const then = previous.onTime / previous.observed;
	const a = wilsonBounds(current);
	const b = wilsonBounds(previous);
	const difference = now - then;
	return {
		difference,
		lower: difference - Math.hypot(now - a.lower, b.upper - then),
		upper: difference + Math.hypot(a.upper - now, then - b.lower),
	};
}

export function comparePeriods(current: PeriodSample, previous: PeriodSample) {
	if (
		[current, previous].some(
			({ days, measuredDays, observed }) => measuredDays * 5 < days * 4 || observed < 100,
		) ||
		Math.abs(current.observedShare - previous.observedShare) > 0.15 + Number.EPSILON
	)
		return null;

	const { difference, lower, upper } = newcombeDifference(current, previous);
	// Check the point threshold on the counts so an exact one-point difference qualifies.
	const numerator = current.onTime * previous.observed - previous.onTime * current.observed;
	const denominator = current.observed * previous.observed;
	const direction =
		Math.abs(numerator) * 100 < denominator
			? 'same'
			: lower > 0
				? 'higher'
				: upper < 0
					? 'lower'
					: 'same';
	return { direction, points: difference * 100 };
}

export function previousPeriod({ from, to }: DateWindow): DateWindow {
	const days = periodDays(from, to);
	if (days === 1) {
		const sameWeekday = addIsoDays(from, -7);
		return { from: sameWeekday, to: sameWeekday };
	}
	return { from: addIsoDays(from, -days), to: addIsoDays(from, -1) };
}
