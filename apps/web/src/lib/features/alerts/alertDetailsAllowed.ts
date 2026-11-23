import type { DateWindow } from '#lib/v1/history/window.ts';

export function alertDetailsAllowed({ from, to }: DateWindow): boolean {
	const elapsed = Date.parse(to) - Date.parse(from);
	return elapsed >= 0 && elapsed < 7 * 86_400_000;
}
