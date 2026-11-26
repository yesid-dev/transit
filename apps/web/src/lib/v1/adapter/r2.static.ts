import { browser } from '$app/env';
import { scheduleIndexSchema, type ScheduleEdition } from '#lib/search/searchIndex.ts';
import { BasemapFileSchema } from '#lib/v1/schemas/basemap.ts';
import { RouteFileSchema } from '#lib/v1/schemas/route.ts';
import { RoutesIndexSchema } from '#lib/v1/schemas/routes_index.ts';
import { StopFileSchema } from '#lib/v1/schemas/stop.ts';
import { StopsIndexSchema } from '#lib/v1/schemas/stops_index.ts';
import { browserAdapterManifest } from './browserManifest';
import { fetchOf, providerOf } from './r2.core';
import type { AdapterCtx } from './types';

const requests = new Map<string, Promise<ScheduleEdition>>();

async function editionFor(ctx?: AdapterCtx): Promise<ScheduleEdition> {
	const city = providerOf(ctx);
	const key = `schedule-edition:${city}`;
	const pending = ctx?.cache?.get(key) as Promise<ScheduleEdition> | undefined;
	if (pending) return pending;
	const request = async () => {
		const response = await fetchOf(ctx)(`/api/schedule-edition?${new URLSearchParams({ city })}`);
		if (!response.ok) throw new Error('Schedule edition unavailable');
		const { schedule } = scheduleIndexSchema.parse(await response.json());
		if (!schedule) throw new Error('Schedule edition unavailable');
		return schedule;
	};
	if (!browser || ctx?.fetch) {
		const result = request();
		ctx?.cache?.set(key, result);
		return result;
	}
	const prior = requests.get(city);
	if (prior) return prior;
	const result = request().finally(() => requests.delete(city));
	requests.set(city, result);
	return result;
}

const generated = (edition: ScheduleEdition) => `${edition.date}T00:00:00Z`;

export function stopFileFromSchedule(stop: ScheduleEdition['stops'][number], date: string) {
	return StopFileSchema.parse({
		...stop,
		generated_utc: `${date}T00:00:00Z`,
		routes_served: stop.routes,
		scheduled: [],
	});
}

export async function getMapRouteDirections(
	ctx?: AdapterCtx,
): Promise<ScheduleEdition['route_directions']> {
	return (await editionFor(ctx)).route_directions;
}

export const staticPort = {
	async routesIndex(ctx?: AdapterCtx) {
		const edition = await editionFor(ctx);
		return RoutesIndexSchema.parse({ generated_utc: generated(edition), routes: edition.routes });
	},
	async route(routeId: string, ctx?: AdapterCtx) {
		const edition = await editionFor(ctx);
		const route = edition.routes.find((route) => route.id === routeId);
		if (!route) return null;
		const names = new Map(edition.stops.map((stop) => [stop.id, stop.name]));
		const directions = (edition.route_directions?.[route.id] ?? []).map((direction) => ({
			...direction,
			stops: (direction.stops ?? []).map((stop) => ({ ...stop, name: names.get(stop.id) })),
		}));
		return RouteFileSchema.parse({
			...route,
			generated_utc: generated(edition),
			directions,
			service_periods: [],
		});
	},
	async stopsIndex(ctx?: AdapterCtx) {
		const edition = await editionFor(ctx);
		return StopsIndexSchema.parse({ generated_utc: generated(edition), stops: edition.stops });
	},
	async stop(stopId: string, ctx?: AdapterCtx) {
		const edition = await editionFor(ctx);
		const stop = edition.stops.find((stop) => stop.id === stopId);
		return stop ? stopFileFromSchedule(stop, edition.date) : null;
	},
};

export const basemapPort = {
	async get(ctx?: AdapterCtx) {
		const manifest = ctx?.manifest ?? browserAdapterManifest();
		if (!manifest?.basemap) return null;
		return BasemapFileSchema.parse({
			url: manifest.basemap,
			generated_utc: manifest.files.static?.generated_utc ?? manifest.files.live.generated_utc,
			attribution: '© OpenStreetMap contributors, © Protomaps',
			format: 'pmtiles',
			min_zoom: 0,
			max_zoom: 15,
		});
	},
};
