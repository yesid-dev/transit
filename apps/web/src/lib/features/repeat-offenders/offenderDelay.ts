import type { Locale } from '#lib/i18n/index.ts';
import { fmtDelayMin } from '#lib/utils/format.ts';
import { roundHalfAwayFromZero } from '#lib/utils/rounding.ts';

/**
 * A published average delay as readers see it: late, early or on time, with its size in minutes
 * and never a sign (owner ruling 6). The direction is read from the value as rounded for display,
 * to one decimal, so -0.04 is on time and never "-0" or "0 min early".
 */
export type AverageDelay =
	| { readonly direction: 'late' | 'early'; readonly minutes: string }
	| { readonly direction: 'onTime' };

export function averageDelay(value: number | null, locale: Locale): AverageDelay | null {
	if (value == null || !Number.isFinite(value)) return null;
	const shown = roundHalfAwayFromZero(value, 1);
	if (shown === 0) return { direction: 'onTime' };
	return {
		direction: shown < 0 ? 'early' : 'late',
		minutes: fmtDelayMin(Math.abs(shown), { rounding: 'auto', locale, suffix: ' min' })!,
	};
}
