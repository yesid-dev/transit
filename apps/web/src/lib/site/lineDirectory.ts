import { lineName, lineSubtitle, riderHeadsign } from '#lib/site/presenter.ts';
import type { LinePattern } from './linePatterns.ts';
import type { Locale } from '#lib/i18n/copy.ts';
import { formatTransitName } from './transitDisplay.ts';
import type { NameSeparators } from '#lib/v1/schemas/providers.ts';
import type { RouteIndexEntry } from '#lib/v1/schemas/routes_index.ts';

export interface LineName {
	readonly number: string | null;
	readonly name: string | null;
	readonly label: string;
	readonly spoken: string;
}
export interface LineDirectory {
	readonly nameSeparators?: NameSeparators;
	spoken(label: string): string;
	name(id: string, publishedName?: string | null): LineName;
	number(id: string): string;
	/** GTFS route_type from the routes index; null when the line is not in it. */
	type(id: string): number | null;
	subtitle(id: string): string | undefined;
	headsign(id: string | null | undefined, name: string | null | undefined): string | undefined;
}

export function createLineDirectory(
	routes: readonly (Pick<RouteIndexEntry, 'id' | 'short'> & Partial<RouteIndexEntry>)[] | null,
	copy: {
		line: (id: string) => string;
		locale?: Locale;
		nameSeparators?: NameSeparators;
		patterns?: Record<string, LinePattern>;
	},
): LineDirectory {
	const index = new Map((routes ?? []).map((route) => [route.id, route]));
	const spoken = (label: string) => copy.line(label);
	return {
		spoken,
		nameSeparators: copy.nameSeparators,
		number: (id) => index.get(id)?.short || id,
		type: (id) => index.get(id)?.type ?? null,
		subtitle: (id) =>
			lineSubtitle(
				index.get(id)?.type ?? null,
				copy.patterns?.[id]?.ends,
				copy.locale ?? 'en',
				copy.nameSeparators,
			),
		headsign: (id, name) => riderHeadsign(name, id ? copy.patterns?.[id] : undefined),
		name(id, publishedName) {
			const route = index.get(id);
			const name = publishedName?.trim() || route?.long;
			return lineName(
				route?.short,
				name && formatTransitName(name, copy.locale ?? 'en', copy.nameSeparators),
				() => copy.line(id),
				spoken,
			);
		},
	};
}
