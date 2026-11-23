import { adapter, type AdapterCtx } from '#lib/v1/adapter/index.ts';
import { providerOf } from '#lib/v1/adapter/r2.core.ts';
import type { RouteFile, RoutesIndex, StopFile, StopsIndex } from '#lib/v1/schemas/index.ts';
import { isSlimStopsIndex, type SlimStopsIndex } from './stopsSlim';

export const getRoutesIndex: (ctx?: AdapterCtx) => Promise<RoutesIndex> = (ctx) =>
	adapter.static.routesIndex(ctx);

export const getRoute: (routeId: string, ctx?: AdapterCtx) => Promise<RouteFile | null> = (
	routeId,
	ctx,
) => adapter.static.route(routeId, ctx);

export const getStopsIndex: (ctx?: AdapterCtx) => Promise<StopsIndex> = (ctx) =>
	adapter.static.stopsIndex(ctx);

export async function getStopsIndexSlim(ctx?: AdapterCtx): Promise<SlimStopsIndex> {
	const fetchFn = ctx?.fetch ?? fetch;
	const search = new URLSearchParams({ provider: providerOf(ctx) });
	const res = await fetchFn(`/api/stops/slim?${search}`, { signal: ctx?.signal });
	if (!res.ok) throw new Error('Schedule stop index unavailable');
	const body: unknown = await res.json();
	if (!isSlimStopsIndex(body)) throw new Error('Invalid schedule stop index');
	return body;
}

export const getStop: (stopId: string, ctx?: AdapterCtx) => Promise<StopFile | null> = (
	stopId,
	ctx,
) => adapter.static.stop(stopId, ctx);
