import { stopDisplayName as displayStop } from '#lib/site/transitDisplay.ts';
import { stopNameFallback } from '#lib/site/absence.ts';
import { clockTime } from '#lib/site/presenter.ts';
import { type Locale } from '#lib/i18n/index.ts';

import type { StopMapDetail } from './mapSelectionSession.svelte';
export function detailStopName(
	{ id, name, nameAbsent }: Pick<StopMapDetail['stop'], 'id' | 'name'> & { nameAbsent?: boolean },
	locale: Locale,
): string {
	const absent = nameAbsent ?? !name;
	return absent ? stopNameFallback(id, locale) : displayStop(name);
}

export function timeLabel(
	iso: string | null | undefined,
	locale: Locale,
	timeZone?: string,
): string {
	if (!iso) return '';
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return '·';
	// Without the published network zone there is no honest reader clock: the host's
	// zone would silently show a different city's time.
	if (!timeZone) return '·';
	return clockTime(date, locale, timeZone);
}

export function formatAge(seconds: number): string {
	return seconds < 90 ? `${Math.round(seconds)} s` : `${Math.round(seconds / 60)} min`;
}
