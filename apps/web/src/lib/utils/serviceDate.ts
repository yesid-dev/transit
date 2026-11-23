export const DISPLAY_TIME_ZONE = 'America/Toronto' as const;

export function providerLocalDateKey(iso: string | null | undefined): string | null {
	if (iso == null) return null;
	const date = new Date(iso);
	if (!Number.isFinite(+date)) return null;
	const parts = new Intl.DateTimeFormat('en', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		timeZone: DISPLAY_TIME_ZONE,
	}).formatToParts(date);
	const year = parts.find((part) => part.type === 'year')?.value;
	const month = parts.find((part) => part.type === 'month')?.value;
	const day = parts.find((part) => part.type === 'day')?.value;
	return year != null && month != null && day != null ? `${year}-${month}-${day}` : null;
}
