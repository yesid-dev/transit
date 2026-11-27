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

function departurePath({ line, direction, departure }: DepartureIdentity) {
	const [hours, minutes, seconds] = departure.split(':');
	const clock = `${hours}${minutes}${seconds === '00' ? '' : `s${seconds}`}`;
	return `/departure/${encodeURIComponent(`${line}-${direction}-${clock}`)}`;
}

/** Replace the identity segment and keep the locale, endpoint suffix and query intact. */
export function canonicalDepartureHref(url: URL, identity: DepartureIdentity) {
	const path = url.pathname.replace(/\/departure\/[^/]+/, departurePath(identity));
	// Fragments are client-side and the browser carries them across this redirect.
	return path === url.pathname ? null : path + url.search;
}

export function isDepartureTripId(trip: string | null): trip is string {
	return Boolean(trip && trip.length <= 256 && trip === trip.trim() && !/[^\S ]|\p{C}/u.test(trip));
}

/** Live departures remain reachable by an opaque trip ID when their timetable key is absent. */
export function departureByTripHref(source: URL, locale: Locale, city: string, trip: string) {
	if (!isDepartureTripId(trip)) return null;
	const target = new URL(
		carryFrameState(localizeHref('/departure/trip', locale, city), source),
		source,
	);
	target.searchParams.set('frameMode', 'live');
	target.searchParams.set('trip', trip);
	return target.pathname + target.search;
}

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
	const target = new URL(
		carryFrameState(localizeHref(departurePath(identity), locale, city), source),
		source,
	);
	target.searchParams.set('frameMode', mode);
	if (trip) target.searchParams.set('trip', trip);
	return target.pathname + target.search;
}

export function departureFromKey(key: string) {
	// Read from the right so hyphens in a line ID remain part of that ID.
	const readable = /^(.+)-([01])-(\d{2,6})([0-5]\d)(?:s([0-5]\d))?$/u.exec(key);
	if (readable) {
		const [, line, direction, hours, minutes, seconds = '00'] = readable;
		return departureIdentity(line, Number(direction), `${hours}:${minutes}:${seconds}`);
	}
	try {
		const value: unknown = JSON.parse(key);
		if (Array.isArray(value) && value.length === 3)
			return departureIdentity(value[0], value[1], value[2]);
	} catch {
		return null;
	}
	return null;
}
