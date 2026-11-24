import type { RouteFile } from '#lib/v1/index.ts';
import type { Vehicle } from '#lib/v1/schemas/index.ts';
import {
	bestShapeForPoint,
	routeShapes,
	type RouteShapes,
} from '#lib/components/map/vehicleShapes.ts';
import type { Coord } from '#lib/components/map/polyline.ts';
import type { ShapeResolver } from '#lib/components/map/motion/projector.ts';

export interface ShapeCacheManager {
	remember(route: RouteFile): void;
	prefetch(vehicles: readonly Vehicle[]): void;
	shapeFor: ShapeResolver & { revision?: () => number };
	subscribe(listener: () => void): () => void;
}

export function createShapeCacheManager(
	getRoutes: (ids: readonly string[]) => Promise<(RouteFile | null)[]>,
): ShapeCacheManager {
	const routeShapeCache = new Map<string, { generatedUtc: string; shapes: RouteShapes }>();
	const routeShapeRequested = new Map<string, symbol>();
	const rememberedRoutes = new WeakSet<RouteFile>();
	let revision = 0;
	const listeners = new Set<() => void>();

	function cacheRoute(id: string, route: RouteFile): void {
		const cached = routeShapeCache.get(id);
		if (
			cached &&
			((cached.generatedUtc === route.generated_utc && rememberedRoutes.has(route)) ||
				Date.parse(route.generated_utc) < Date.parse(cached.generatedUtc))
		)
			return;
		const shapes = routeShapes(route);
		rememberedRoutes.add(route);
		routeShapeRequested.set(id, Symbol());
		routeShapeCache.set(id, { generatedUtc: route.generated_utc, shapes });
		if (shapes.length > 0 || (cached?.shapes.length ?? 0) > 0) revision += 1;
		for (const listener of listeners) listener();
	}

	function prefetch(vehicles: readonly Vehicle[]): void {
		const requests = new Map<string, symbol>();
		for (const v of vehicles) {
			const id = v.route;
			if (id == null || id === '') continue;
			if (routeShapeRequested.has(id)) continue;
			const request = Symbol();
			routeShapeRequested.set(id, request);
			requests.set(id, request);
		}
		if (!requests.size) return;
		void getRoutes([...requests.keys()])
			.then((routes) => {
				for (const route of routes) {
					if (route && routeShapeRequested.get(route.id) === requests.get(route.id)) {
						cacheRoute(route.id, route);
					}
				}
			})
			.catch(() => {
				for (const [id, request] of requests) {
					if (routeShapeRequested.get(id) !== request) continue;
					routeShapeRequested.delete(id);
					revision += 1;
				}
			});
	}

	const shapeFor: ShapeCacheManager['shapeFor'] = (feature) => {
		const routeId = feature.properties.route;
		if (!routeId) return null;
		const shapes = routeShapeCache.get(routeId)?.shapes;
		if (!shapes || shapes.length === 0) return null;
		return bestShapeForPoint(
			shapes,
			feature.geometry.coordinates as Coord,
			60,
			feature.properties.hasHeading ? feature.properties.bearing : null,
		);
	};
	shapeFor.revision = () => revision;

	return {
		prefetch,
		remember: (route) => cacheRoute(route.id, route),
		shapeFor,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
