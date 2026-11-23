import { z } from 'zod';
import { RouteIndexEntrySchema } from '#lib/v1/schemas/routes_index.ts';
import { StopIndexEntrySchema } from '#lib/v1/schemas/stops_index.ts';

export const searchIndexSchema = z.object({
	schedule: z
		.object({
			date: z.iso.date(),
			routes: z.array(
				RouteIndexEntrySchema.pick({ id: true, short: true, long: true, type: true, color: true }),
			),
			stops: z.array(StopIndexEntrySchema),
		})
		.nullable(),
	vehicles: z.array(z.object({ id: z.string() })).nullable(),
	vehicle_state: z.enum(['ready', 'not_tracked', 'unavailable']),
});

export type SearchIndex = z.infer<typeof searchIndexSchema>;

export async function loadSearchIndex(city: string, signal: AbortSignal): Promise<SearchIndex> {
	const response = await fetch(`/api/search-index?${new URLSearchParams({ city })}`, { signal });
	if (!response.ok) throw new Error('Search index unavailable');
	return searchIndexSchema.parse(await response.json());
}
