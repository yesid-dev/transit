import { localizeHref, type Locale } from '#lib/i18n/index.ts';
import { carryFrameState, type FrameMode } from '#lib/site/frameState.ts';

export function departureIdentity(line: unknown, direction: unknown, departure: unknown) {
	if (
		typeof line !== 'string' ||
		!line ||
		line.trim() !== line ||
		/[^\S ]|\p{C}/u.test(line) ||
		(direction !== 0 && direction !== 1) ||
		typeof departure !== 'string' ||
		!/^\d{2,6}:[0-5]\d:[0-5]\d$/.test(departure)
	)
		return null;
	return { line, direction, departure };
}

export type DepartureIdentity = NonNullable<ReturnType<typeof departureIdentity>>;

export function departureHref(
	source: URL,
	locale: Locale,
	city: string,
	line: string,
	direction: number | null,
	departure: string,
	mode: FrameMode = 'record',
	trip?: string,
) {
	const identity = departureIdentity(line, direction, departure);
	if (!identity) return null;
	const key = encodeURIComponent(JSON.stringify([line, direction, departure]));
	const target = new URL(
		carryFrameState(localizeHref(`/departure/${key}`, locale, city), source),
		source,
	);
	target.searchParams.set('frameMode', mode);
	if (trip) target.searchParams.set('trip', trip);
	return target.pathname + target.search;
}

export function departureFromKey(key: string) {
	try {
		const value: unknown = JSON.parse(key);
		if (Array.isArray(value) && value.length === 3)
			return departureIdentity(value[0], value[1], value[2]);
	} catch {
		return null;
	}
	return null;
}
