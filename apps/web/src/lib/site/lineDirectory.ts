import { lineName } from '#lib/site/presenter.ts';
import type { RouteIndexEntry } from '#lib/v1/schemas/routes_index.ts';

export interface LineName {
	readonly number: string | null;
	readonly name: string | null;
	readonly label: string;
	readonly spoken: string;
}
export interface LineDirectory {
	spoken(label: string): string;
	name(id: string, publishedName?: string | null): LineName;
	number(id: string): string;
	/** GTFS route_type from the routes index; null when the line is not in it. */
	type(id: string): number | null;
}

export function createLineDirectory(
	routes: readonly (Pick<RouteIndexEntry, 'id' | 'short'> & Partial<RouteIndexEntry>)[] | null,
	copy: { line: (id: string) => string },
): LineDirectory {
	const index = new Map((routes ?? []).map((route) => [route.id, route]));
	const spoken = (label: string) => copy.line(label);
	return {
		spoken,
		number: (id) => index.get(id)?.short || id,
		type: (id) => index.get(id)?.type ?? null,
		name(id, publishedName) {
			const route = index.get(id);
			return lineName(
				route?.short,
				publishedName?.trim() || route?.long,
				() => copy.line(id),
				spoken,
			);
		},
	};
}
