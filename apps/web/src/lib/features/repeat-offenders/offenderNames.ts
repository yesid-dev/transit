import type { LineDirectory } from '#lib/site/lineDirectory.ts';
import type { RepeatOffenderEntry } from '#lib/v1/schemas/index.ts';
import type { RepeatOffendersCopy } from './repeatOffenders.copy';

function departureClock(value: string | null | undefined): string | null {
	const parts = /^(\d+):(\d{1,2}):(\d{1,2})$/.exec(value?.trim() ?? '');
	if (!parts || Number(parts[2]) > 59 || Number(parts[3]) > 59) return null;
	return `${parts[1]}:${parts[2].padStart(2, '0')}`;
}

export function resolveOffenderName(
	entry: RepeatOffenderEntry,
	directory: LineDirectory | undefined,
	fallback: (entry: RepeatOffenderEntry) => string,
): { label: string; spoken: string } {
	if (
		entry.route?.trim() &&
		[entry.route_short_name, entry.departure_time, entry.headsign].some((value) => value?.trim())
	) {
		const label = fallback(entry);
		return { label, spoken: label };
	}
	if (directory && entry.route) return directory.name(entry.route, entry.route_name);
	const label = entry.route_name ?? fallback(entry);
	return { label, spoken: directory && entry.route_name ? directory.spoken(label) : label };
}

export function createOffenderNames(lines: () => LineDirectory, copy: () => RepeatOffendersCopy) {
	const name = (entry: RepeatOffenderEntry) =>
		resolveOffenderName(entry, lines(), (item) => {
			const route = item.route?.trim();
			if (!route) return copy().unnamed(item.id);
			const line = item.route_short_name?.trim() || route;
			const departure = departureClock(item.departure_time);
			return copy().departure(line, departure, item.headsign?.trim() || null);
		});
	return {
		unnamed: (entry: RepeatOffenderEntry) => name(entry).label,
		spoken: (entry: RepeatOffenderEntry) => name(entry).spoken,
		typeLabel: (type: string) =>
			new Map(Object.entries(copy().type)).get(type) ?? copy().type.other,
	};
}
