import type { LineDirectory } from '#lib/site/lineDirectory.ts';
import type { RepeatOffenderEntry } from '#lib/v1/schemas/index.ts';
import type { RepeatOffendersCopy } from './repeatOffenders.copy';

/** How a ranked trip or bus is named on the page, in its language. */
export interface OffenderIdentity {
	/** The line number shown as a plate; null when the row names no line. */
	readonly number: string | null;
	/** What is ranked: "07:42 toward Monk", "Trip 302181944" or "Bus 4672". */
	readonly primary: string;
	/** The line's full published name, never truncated; null when unknown or equal to its number. */
	readonly lineName: string | null;
	/** One sentence naming the row, for findings, citations and screen readers. */
	readonly label: string;
}

/** "07:42" from a service clock; hours past 24 stay as published. */
function departureClock(value: string | null | undefined): string | null {
	const parts = /^(\d+):(\d{1,2}):(\d{1,2})$/.exec(value?.trim() ?? '');
	if (!parts || Number(parts[2]) > 59 || Number(parts[3]) > 59) return null;
	return `${parts[1]}:${parts[2].padStart(2, '0')}`;
}

/**
 * Names a row from what the record publishes. A departure's clock and destination appear only
 * when published (#1080); older files name the trip by its number instead, never by an invented
 * departure. The published historical line number wins over today's directory.
 */
export function offenderIdentity(
	entry: RepeatOffenderEntry,
	directory: LineDirectory,
	copy: RepeatOffendersCopy,
): OffenderIdentity {
	const route = entry.route?.trim() || null;
	const line = route ? directory.name(route, entry.route_name) : null;
	const number = entry.route_short_name?.trim() || line?.number || route;
	const lineName = line?.name && line.name !== number ? line.name : null;
	const time = departureClock(entry.departure_time);
	const headsign = entry.headsign?.trim() || null;
	const departure = entry.type === 'trip' && (time != null || headsign != null);
	const primary = departure
		? copy.departureDetail(time, headsign)
		: `${entry.type === 'vehicle' ? copy.type.vehicle : copy.type.trip} ${entry.id}`;
	const label =
		number == null
			? primary
			: departure
				? copy.departure(number, time, headsign)
				: copy.onLine(primary, number, lineName);
	return { number, primary, lineName, label };
}
