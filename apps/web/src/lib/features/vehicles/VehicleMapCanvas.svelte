<script lang="ts">
	import { theme } from '@yesid/ui/state';
	import { Marker, type Map as MapLibreMap } from 'maplibre-gl';
	import { stopDisplayName } from '#lib/site/transitDisplay.ts';
	import MapStage from '#lib/components/map/MapStage.svelte';
	import { setRouteLines } from '#lib/components/map/routeLines.ts';
	import { setStops } from '#lib/components/map/stopsLayer.ts';
	import { createVehicleOverlay, type VehicleOverlay } from '#lib/components/map/vehicleOverlay.ts';
	import { toVehicleFeatures } from '#lib/components/map/vehicleLayer.ts';
	import { retintMapLayers } from '#lib/features/map/mapLayerModules.ts';
	import { emptyFilterState } from '#lib/filters/index.ts';
	import { providerAttribution } from '#lib/i18n/providerAttribution.ts';
	import type { Locale } from '#lib/i18n/index.ts';
	import { getBasemap } from '#lib/v1/repositories/basemap.ts';
	import type { Manifest, RouteFile, Vehicle } from '#lib/v1/schemas/index.ts';
	import type { VehicleMapStop } from './vehicleLocationRoute.ts';

	let {
		vehicle,
		manifest,
		route,
		next,
		previous,
		locale,
		onready,
		onrecovering,
		onunavailable,
	}: {
		vehicle: Vehicle;
		manifest: Manifest;
		route: RouteFile | null;
		next?: VehicleMapStop;
		previous?: VehicleMapStop;
		locale: Locale;
		onready: () => void;
		onrecovering: () => void;
		onunavailable: () => void;
	} = $props();

	const fr = $derived(locale === 'fr');
	const filter = { ...emptyFilterState(), showOutOfService: true };
	const stops = $derived(
		[previous, next?.id === previous?.id ? undefined : next].filter(
			(stop): stop is VehicleMapStop => !!stop,
		),
	);
	const bounds = $derived.by(() => {
		const points = [vehicle, ...stops];
		const lons = points.map(({ lon }) => lon);
		const lats = points.map(({ lat }) => lat);
		// Leave a neighbourhood in view when a vehicle reports without a nearby stop.
		const margin = 0.001;
		return [
			Math.min(...lons) - margin,
			Math.min(...lats) - margin,
			Math.max(...lons) + margin,
			Math.max(...lats) + margin,
		];
	});
	let map = $state.raw<MapLibreMap | null>(null);
	let overlay: VehicleOverlay | null = null;

	function paintLayers(instance: MapLibreMap) {
		const { sprites, pin } = retintMapLayers(instance);
		if (overlay) overlay.setSprites(sprites, pin);
		else
			overlay = createVehicleOverlay(instance, sprites, pin, undefined, undefined, {
				minimumBodySize: 56,
			});
	}

	function attach(instance: MapLibreMap) {
		instance.getCanvas().tabIndex = -1;
		paintLayers(instance);
		map = instance;
	}

	function release() {
		map = null;
		overlay?.destroy();
		overlay = null;
	}

	$effect(() => {
		if (!map) return;
		setRouteLines(map, route ? [route] : [], route && { id: route.id });
	});

	$effect(() => {
		if (!map) return;
		overlay?.setScene(false, null, null, vehicle.id);
		overlay?.draw(toVehicleFeatures([vehicle], filter, undefined, vehicle.id));
	});

	$effect(() => {
		const instance = map;
		if (!instance) return;
		setStops(
			instance,
			stops.map((stop) => ({ ...stop, routes: [] })),
		);
		const labels = stops.map((stop) => {
			const anchor = document.createElement('div');
			anchor.className = 'vehicle-map-stop-anchor';
			const element = document.createElement('span');
			element.className = 'vehicle-map-stop-name';
			anchor.append(element);
			const left = stop.id === previous?.id;
			const label = left ? (fr ? 'Quitté :' : 'Left:') : fr ? 'Prochain :' : 'Next:';
			element.textContent = `${label} ${stopDisplayName(stop.name)}`;
			element.title = element.textContent;
			const north = stop.lat === vehicle.lat ? left : stop.lat > vehicle.lat;
			const marker = new Marker({
				element: anchor,
				anchor: north ? 'bottom' : 'top',
				offset: [0, north ? -34 : 34],
			})
				.setLngLat([stop.lon, stop.lat])
				.addTo(instance);
			return { marker, element };
		});
		const placeLabels = () => {
			const width = instance.getContainer().clientWidth;
			for (const { marker, element } of labels) {
				const center = instance.project(marker.getLngLat()).x;
				const inset = element.offsetWidth / 2 + 8;
				const clamped = Math.min(width - inset, Math.max(inset, center));
				element.style.translate = `${clamped - center}px`;
			}
		};
		placeLabels();
		instance.on('move', placeLabels);
		instance.on('resize', placeLabels);
		return () => {
			instance.off('move', placeLabels);
			instance.off('resize', placeLabels);
			labels.forEach(({ marker }) => marker.remove());
		};
	});
</script>

<div class="vehicle-map-canvas @container h-full">
	<MapStage
		interactive={false}
		{bounds}
		maxBounds={manifest.bbox}
		fitPadding={{ top: 48, bottom: 48, left: 24, right: 24 }}
		basemapLoader={({ signal }) => getBasemap({ signal })}
		theme={theme.current}
		label={fr ? 'Position du véhicule et arrêts à proximité' : 'Vehicle position and nearby stops'}
		customAttribution={providerAttribution(manifest.provider, manifest.attribution, locale)}
		locale={{
			'AttributionControl.ToggleAttribution': fr
				? 'Afficher les sources de la carte'
				: 'Show map sources',
		}}
		onready={attach}
		onidle={onready}
		{onrecovering}
		onthemerepaint={paintLayers}
		onerror={(failure) => {
			if (failure) onunavailable();
		}}
		onbeforeremove={release}
	/>
</div>

<style>
	.vehicle-map-canvas :global([data-slot='vehicle-overlay']) {
		z-index: 1;
	}

	.vehicle-map-canvas :global(.vehicle-map-stop-anchor) {
		pointer-events: none;
	}

	.vehicle-map-canvas :global(.vehicle-map-stop-name) {
		display: block;
		max-inline-size: min(16rem, calc(100cqi - 1rem));
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		padding: 0.125rem 0.375rem;
		border-radius: var(--radius-sm);
		background: var(--card);
		color: var(--foreground);
		font-size: var(--text-caption);
	}
</style>
