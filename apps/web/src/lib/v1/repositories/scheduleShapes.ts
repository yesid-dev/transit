import { scheduleMapSchema, type ScheduleMap } from '#lib/search/searchIndex.ts';
import { fetchOf, providerOf } from '#lib/v1/adapter/r2.core.ts';
import type { AdapterCtx } from '#lib/v1/adapter/types.ts';
import type { RouteFile } from '#lib/v1/schemas/route.ts';
import { getRoute } from './static';

const pending = new Map<string, Promise<ScheduleMap | null>>();

function fetchShapes(search: URLSearchParams, ctx?: AdapterCtx) {
	const url = '/api/schedule-map?' + search;
	const existing = ctx?.fetch ? undefined : pending.get(url);
	if (existing) return existing;
	const result = fetchOf(ctx)(url)
		.then(async (response) => {
			if (!response.ok) return null;
			const parsed = scheduleMapSchema.safeParse(await response.json());
			return parsed.success ? parsed.data.schedule : null;
		})
		.catch(() => null);
	if (!ctx?.fetch) {
		pending.set(url, result);
		void result.finally(() => pending.delete(url));
	}
	return result;
}

export function getScheduleShapes(ids: readonly string[], ctx?: AdapterCtx) {
	const city = providerOf(ctx);
	const params = (lines: string[]) => new URLSearchParams({ city, lines: JSON.stringify(lines) });
	const requests: Promise<ScheduleMap | null>[] = [];
	let batch: string[] = [];
	for (const id of [...new Set(ids)].sort()) {
		const next = [...batch, id];
		if (batch.length && (next.length > 256 || params(next).toString().length > 4096)) {
			requests.push(fetchShapes(params(batch), ctx));
			batch = [id];
		} else {
			batch = next;
		}
	}
	if (batch.length) requests.push(fetchShapes(params(batch), ctx));
	return Promise.all(requests);
}

export function withScheduleShapes(route: RouteFile, maps: readonly (ScheduleMap | null)[]) {
	const date = route.generated_utc.slice(0, 10);
	const shapes = maps.find((map) => map?.date === date && Object.hasOwn(map.route_shapes, route.id))
		?.route_shapes[route.id];
	if (!shapes?.length || !route.directions?.length) return route;
	return {
		...route,
		directions: route.directions.map((direction) => {
			const shape = shapes.find(
				(branch) =>
					branch.dir === direction.dir && (branch.headsign ?? '') === (direction.headsign ?? ''),
			)?.shape;
			return shape ? { ...direction, shape } : direction;
		}),
	};
}

export async function getMapRoutes(ids: readonly string[], ctx?: AdapterCtx) {
	const [routes, shapes] = await Promise.all([
		Promise.all(ids.map((id) => getRoute(id, ctx))),
		getScheduleShapes(ids, ctx),
	]);
	if (shapes.some((map) => map === null)) throw new Error('Schedule map unavailable');
	return routes.map((route) => (route ? withScheduleShapes(route, shapes) : null));
}
