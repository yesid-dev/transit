import { z } from 'zod';
import { RouteIndexEntrySchema } from '#lib/v1/schemas/routes_index.ts';
import { RouteDirectionSchema } from '#lib/v1/schemas/route.ts';
import { StopIndexEntrySchema } from '#lib/v1/schemas/stops_index.ts';
import type { Resource } from '#lib/v1/resource.svelte.ts';
import {
	searchQueryState,
	searchTransit,
	type ListSearchRequest,
	type SearchList,
	type SearchSources,
} from './transitSearch.ts';

export const scheduleSchema = z.object({
	date: z.iso.date(),
	routes: z.array(
		RouteIndexEntrySchema.pick({ id: true, short: true, long: true, type: true, color: true }),
	),
	stops: z.array(
		StopIndexEntrySchema.extend({
			wheelchair_boarding: z.enum(['yes', 'no']).nullable().optional(),
		}),
	),
});

export const scheduleIndexSchema = z.object({
	schedule: scheduleSchema
		.extend({
			route_directions: z
				.record(z.string(), z.array(RouteDirectionSchema.omit({ shape: true })))
				.optional(),
		})
		.nullable(),
});
export type ScheduleEdition = NonNullable<z.infer<typeof scheduleIndexSchema>['schedule']>;
export const scheduleMapSchema = z.object({
	schedule: z
		.object({
			date: z.iso.date(),
			route_shapes: z.record(
				z.string(),
				z.array(RouteDirectionSchema.pick({ dir: true, headsign: true, shape: true })),
			),
		})
		.nullable(),
});
export type ScheduleMap = NonNullable<z.infer<typeof scheduleMapSchema>['schedule']>;

export const searchIndexSchema = z.object({
	schedule: scheduleSchema.nullable(),
	vehicles: z.array(z.object({ id: z.string() })).nullable(),
	vehicle_state: z.enum(['ready', 'not_tracked', 'unavailable']),
});

export type SearchIndex = z.infer<typeof searchIndexSchema>;

export function searchIndexList(
	request: ListSearchRequest,
	index: Pick<Resource<SearchIndex>, 'data' | 'error' | 'settled' | 'loading'>,
	sources: Pick<SearchSources, 'locale' | 'nameSeparators' | 'pages'>,
): SearchList {
	const data = index.error ? null : index.data;
	const vehiclesNotTracked = data?.vehicle_state === 'not_tracked';
	return {
		...searchTransit(
			{ ...request, query: searchQueryState(request.query) === 'ready' ? request.query : '' },
			{
				...sources,
				routes: data?.schedule?.routes ?? null,
				stops: data?.schedule?.stops ?? null,
				vehicles: vehiclesNotTracked ? [] : (data?.vehicles ?? null),
			},
		),
		indexSettled: index.settled && !index.loading,
		vehiclesNotTracked,
	};
}

export async function loadSearchIndex(city: string, signal: AbortSignal): Promise<SearchIndex> {
	const response = await fetch(`/api/search-index?${new URLSearchParams({ city })}`, { signal });
	if (!response.ok) throw new Error('Search index unavailable');
	return searchIndexSchema.parse(await response.json());
}
