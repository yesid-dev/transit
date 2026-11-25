import type { StopIndexEntry } from '#lib/v1/schemas/stops_index.ts';
import { foldSearchText } from './normalize';

const MODE_TAGS = {
	metro: 'Métro',
	tram: 'Tram',
	rail: 'Train',
	bus: 'Bus',
	ferry: 'Ferry',
} as const;
export type TransitModeKey = keyof typeof MODE_TAGS;
type TransitModeTag = (typeof MODE_TAGS)[keyof typeof MODE_TAGS];

const TAG_TO_MODE_KEY = Object.fromEntries(
	(Object.entries(MODE_TAGS) as [TransitModeKey, TransitModeTag][]).map(([key, tag]) => [tag, key]),
) as Record<TransitModeTag, TransitModeKey>;

const ROUTE_TYPE_GLYPH: Record<number, string> = {
	0: '╤',
	1: '◉',
	2: '╪',
	3: '═',
	4: '≈',
};

const ROUTE_TYPE_TAG: Record<number, TransitModeTag> = {
	0: MODE_TAGS.tram,
	1: MODE_TAGS.metro,
	2: MODE_TAGS.rail,
	3: MODE_TAGS.bus,
	4: MODE_TAGS.ferry,
};

interface RouteModeHint {
	readonly glyph: string;
	readonly tag: TransitModeTag | null;
}

export function routeModeHint(type: number): RouteModeHint {
	return {
		glyph: ROUTE_TYPE_GLYPH[type] ?? '═',
		tag: ROUTE_TYPE_TAG[type] ?? null,
	};
}

export function routeModeKey(type: number): TransitModeKey | null {
	const tag = routeModeHint(type).tag;
	return tag ? TAG_TO_MODE_KEY[tag] : null;
}

/** Published métro and rail platforms share their station's name; every other stop keeps its code. */
export function stopGroupKey(stop: {
	readonly name: string;
	readonly code?: string | null;
	readonly id: string;
	readonly mode?: StopIndexEntry['mode'];
}): string {
	return stop.mode === 'metro' || stop.mode === 'rail'
		? `name:${foldSearchText(stop.name)}`
		: `code:${stop.code ?? stop.id}`;
}
