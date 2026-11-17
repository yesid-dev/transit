<script lang="ts">
	import MapDetailNavigation from './MapDetailNavigation.svelte';
	import { providerAttribution } from '#lib/i18n/providerAttribution.ts';
	import { hasOccupancy } from '#lib/site/transitDisplay.ts';
	import { liveTimingFor } from '#lib/components/map/liveTiming.ts';
	import { liveReader } from '#lib/v1/adapter/index.ts';
	import { provideLiveAbsenceContext } from '#lib/site/absence.ts';
	import { measureMapFocusInset } from './mapFocusInset';
	import { providerHasAlerts } from '#lib/v1/providers.ts';
	import { onMount, tick, untrack } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import type { Map as MapLibreMap } from 'maplibre-gl';
	import type { MapStageFailure } from '#lib/components/map/MapStage.svelte';
	import { getLocale, type Locale } from '#lib/i18n/index.ts';
	import { clock, desktop, theme } from '@yesid/ui/state';
	import { getV1Runtime } from '#lib/v1/runtime.ts';
	const dataClock = getV1Runtime().clock;
	import { StateNotice } from '@yesid/ui/feedback';
	import { Button } from '@yesid/ui/button';
	import { livePresentation } from '#lib/v1/live/livePresentation.ts';
	import { LIVE_FAMILIES, createLiveStore } from '#lib/v1/live/store.svelte.ts';
	import { getV1Context } from '#lib/v1/boot.ts';
	import { getBasemap } from '#lib/v1/repositories/basemap.ts';
	import {
		getRoute,
		getRoutesIndex,
		getStop,
		getStopsIndexSlim,
	} from '#lib/v1/repositories/static.ts';
	import type { SlimStopEntry } from '#lib/v1/index.ts';
	import { createFilterStore, fromSearchParams } from '#lib/filters/index.ts';
	import { nearTargetFromSearchParams } from '#lib/search/mapNear.ts';
	import { parseMapFocus } from '#lib/search/mapFocus.ts';
	import { lineLabel, stopDisplayName } from '#lib/site/transitDisplay.ts';
	import { RightPanel } from '#lib/components/shell/index.ts';
	import { MapStage, nearestStops, type WithDistance } from '#lib/components/map/index.ts';
	import { createVehicleMotion } from './vehicleMotion';
	import { motionMode } from '#lib/stores/index.ts';
	import { prefersReducedMotion } from '@yesid/motion/stores/reducedMotion';
	import MapFilters from './MapFilters.svelte';
	import MapMotionControl from './MapMotionControl.svelte';
	import MapSelectionDetail from './MapSelectionDetail.svelte';
	import MapSurfaceCanvasLayer from './MapSurfaceCanvasLayer.svelte';
	import MapOverlayChrome from './MapOverlayChrome.svelte';
	import MapDetailOverlay from './MapDetailOverlay.svelte';
	import MapMobileDetailSheet from './MapMobileDetailSheet.svelte';
	import { zoomForNearMePrecision } from './mapGeo';
	import {
		focusCoordinate,
		fitRouteBounds,
		initialCamera,
		createMapCamera,
		resetNorth,
	} from './mapCamera';
	import {
		buildNearTargetSearch,
		clearNearTargetSearch,
		buildFocusClearSearch,
	} from './mapUrlSync';
	import { nearTargetKey } from './mapNearMe';
	import { createMapNearMeController, type NearMeOrigin } from './mapNearMeController.svelte';
	import { createMapFocusController } from './mapFocusController.svelte';
	import { createMapUrlCoordinator, MAP_URL_REWRITE } from './mapUrlCoordinator';
	import { mapCopy } from './map.copy';
	import { publishRailOffset, readStoredDetailPanelWidth } from './mapDetailPanes';
	import { createMapRuntime, type MapRuntimeFeed } from './mapRuntime.svelte';
	import { createMapSelectionSession, type MapSelection } from './mapSelectionSession.svelte';
	import * as ownerCleanup from './mapOwnerCleanup';
	import { captureMapReportCamera, type MapReportCamera } from './mapReportCamera';
	import { buildMapReportView, mapReportFilterTokens } from './mapReports';
	import { mapReportFilterLabels } from './mapReportFilterSummary';
	import { mapReportsCopy } from './mapReports.copy';
	import { buildMapReportLiveViewHref } from './mapReportsLink';
	import { parseMapViewHint, type MapViewHint } from './mapViewHint';
	import MapReportsPanel from './MapReportsPanel.svelte';

	interface Props {
		onready?: () => void;
		onidle?: () => void;
		onrecovering?: () => void;
		onfailure?: (failure: MapStageFailure | null) => void;
	}

	let { onready, onidle, onrecovering, onfailure }: Props = $props();

	const locale: Locale = getLocale();
	const v1 = getV1Context();
	const manifest = v1.manifest;
	const t = mapCopy(locale, v1.provider?.labels[locale].city ?? manifest.city ?? manifest.provider);

	const alertsAvailable = providerHasAlerts(v1.provider);
	function readMapFilters(params: URLSearchParams) {
		const state = fromSearchParams(params);
		return alertsAvailable ? state : { ...state, alerts: [] };
	}

	let mapWidthPx = $state(1280);

	let detailWidthPx = $state(readStoredDetailPanelWidth());
	let detailCollapsed = $state(readStoredDetailPanelWidth() === 56);
	let heroEl = $state<HTMLDivElement | null>(null);
	let detailDragging = $state(false);
	const detailResizeAria = $derived(t.detailResizeLabel);
	const framing = $derived(initialCamera(v1, mapWidthPx, desktop.current));
	const urlCoordinator = createMapUrlCoordinator(new URL(page.url.href), goto);
	const filters = createFilterStore(
		readMapFilters(new URLSearchParams(page.url.search)),
		urlCoordinator.writeFilters,
	);

	const nearMeController = createMapNearMeController({
		providerId: manifest.provider,
		bbox: manifest.bbox,
		locale,
		goto: urlCoordinator.goto,
		currentUrl: urlCoordinator.currentUrl,
		readTarget: (params) => nearTargetFromSearchParams(params, manifest.bbox),
		targetKey: nearTargetKey,
		buildTargetSearch: buildNearTargetSearch,
		clearTargetSearch: clearNearTargetSearch,
		focusOrigin: focusNearMeOrigin,
		fetch: (input, init) => globalThis.fetch(input, init),
		getGeolocation: () => (typeof navigator === 'undefined' ? null : navigator['geolocation']),
		isSecureContext: () => typeof window === 'undefined' || window.isSecureContext,
		translations: t,
	});
	const focusController = createMapFocusController({
		readFocus: parseMapFocus,
		clearFocus: () => {
			const url = urlCoordinator.currentUrl();
			void urlCoordinator.goto(
				buildFocusClearSearch(url.searchParams, url.pathname),
				MAP_URL_REWRITE,
			);
		},
	});
	let recovering = $state(false);
	let orientation = $state({ bearing: 0, pitch: 0 });
	let northPending = false;
	let northStatus = $state('');
	function onMapOrientation(next: { bearing: number; pitch: number }): void {
		orientation = next;
		if (next.bearing !== 0 || next.pitch !== 0) northStatus = '';
		if (northPending && next.bearing === 0 && next.pitch === 0) {
			northPending = false;
			northStatus = t.northStatus;
		}
	}
	function turnNorth(): void {
		if (!map || recovering) return;
		northStatus = '';
		northPending = true;
		resetNorth(map);
		map.getCanvas().focus({ preventScroll: true });
	}
	const camera = createMapCamera<MapSelection>();
	const cameraIntents = camera.intents;
	let recoveryFocusTarget: HTMLElement | null = null;

	let ingestedUrlIdentity = '';
	$effect(() => {
		const url = new URL(page.url.href);
		const urlIdentity = `${url.pathname}${url.search}`;
		if (urlIdentity === ingestedUrlIdentity) return;
		ingestedUrlIdentity = urlIdentity;
		filters.replaceFromUrl(readMapFilters(url.searchParams), urlCoordinator.settle(url));
		if (!ingestedViewHint) {
			ingestedViewHint = true;
			pendingViewHint = parseMapViewHint(
				url.searchParams,
				v1.provider?.max_bounds ?? manifest.bbox ?? null,
			);
		}
		if (!alertsAvailable && url.searchParams.has('alert')) {
			const next = new URL(url);
			next.searchParams.delete('alert');
			void urlCoordinator.goto(`${next.pathname}${next.search}`, MAP_URL_REWRITE);
		}
		nearMeController.syncFromUrl(url.searchParams);
		const previousFocus = focusController.pending;
		focusController.syncFromUrl(url.searchParams);
		if (recovering && focusController.pending !== previousFocus) {
			if (focusController.pending) cameraIntents.state({ kind: 'url' });
			else if (cameraIntents.pending?.kind === 'url') cameraIntents.state(null);
		}
	});

	const live = createLiveStore(manifest, liveReader, {
		families: alertsAvailable ? ['vehicles', 'alerts'] : ['vehicles'],
	});
	const occupancyAvailable = $derived(
		hasOccupancy(manifest.provider, live.vehicles?.vehicles ?? []),
	);
	$effect(() => {
		if (!occupancyAvailable && filters.occupancy.length) filters.setOccupancy([]);
	});
	function reportMapCleanupFailure(error: unknown): void {
		ownerCleanup.reportCleanupFailure('MapHero cleanup failed', error);
	}
	function releaseMapOwner(dispose: () => void): void {
		ownerCleanup.releaseWithRetry(dispose, reportMapCleanupFailure);
	}
	$effect(() => () => {
		releaseMapOwner(nearMeController.dispose);
		releaseMapOwner(urlCoordinator.dispose);
	});
	onMount(() => {
		live.start();
		return () => releaseMapOwner(() => live.stop());
	});

	$effect(() => {
		const unsubscribe = clock.subscribe();
		return () => releaseMapOwner(unsubscribe);
	});

	let mapFailure = $state<MapStageFailure | null>(null);
	let hasFirstIdle = $state(false);
	const vehicleMotion = createVehicleMotion(getRoute, {
		now: () => untrack(() => clock.serverNow),
		continuous: () => untrack(() => clock.serverNowContinuousMs()),
	});
	const session = createMapSelectionSession({
		live,
		repositories: { getRoute, getStop, getStopsIndexSlim, getRoutesIndex },
		filters,
		locale,
		timeZone: manifest.tz,
		staleCutoffS: liveTimingFor(manifest).staleCutoffS,
		serverNow: () => dataClock.serverNow,
		alertsAvailable,
	});
	const runtime = createMapRuntime({
		selection: session,
		readFeed: readMapFeed,
		onpick: selectPickedFeature,
	});
	const map = $derived(runtime.map);

	// One camera capture per settled move or resize. Animation frames never rebuild the list.
	$effect(() => {
		const instance = map;
		if (!instance) {
			reportCamera = null;
			return;
		}
		// Listener registration and projection read the map's own state; only `map` is a dependency.
		return untrack(() => {
			let frame = 0;
			const capture = () => {
				frame = 0;
				reportCamera = captureMapReportCamera(instance);
			};
			const onMoveEnd = () => capture();
			const onResize = () => {
				if (!frame) frame = requestAnimationFrame(capture);
			};
			instance.on('moveend', onMoveEnd);
			instance.on('resize', onResize);
			capture();
			return () => {
				instance.off('moveend', onMoveEnd);
				instance.off('resize', onResize);
				if (frame) cancelAnimationFrame(frame);
			};
		});
	});

	// On a phone, Escape leaves the report list for the map and returns focus to the switch.
	$effect(() => {
		if (desktop.current || viewMode !== 'reports') return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== 'Escape' || event.defaultPrevented) return;
			if (document.querySelector('[data-slot="bottom-sheet"][data-state="open"]')) return;
			viewMode = 'map';
			void tick().then(focusMapViewSwitch);
		};
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	});

	const detailOpen = $derived(session.detailOpen);
	$effect(() => {
		if (!detailOpen) detailCollapsed = detailWidthPx === 56;
	});

	const stopList = $derived(session.stops);
	const selectedDetail = $derived(session.detail);
	const selectionPresence = $derived(session.presence);
	const selectionSourceHealth = $derived(session.sourceHealth);
	const selectedVehicleAbsence = $derived(session.vehicleAbsence);
	const detailSurfaceKey = $derived(session.surfaceKey);
	const hoverPeek = $derived(session.hoverPeek);
	const routeList = $derived(session.routeList);
	const routeLineRoutes = $derived(session.routeLineRoutes);
	const selectedRouteLine = $derived(session.selectedRouteLine);
	const selectedVehicleId = $derived(session.selectedVehicleId);
	const selectedStopId = $derived(session.selectedStopId);
	const alertVehicleIds = $derived(session.alertVehicleIds);
	provideLiveAbsenceContext(() => ({
		familyStates: live.familyStates,
		providerId: v1.manifest.provider,
		staleCutoffS: liveTimingFor(manifest).staleCutoffS,
	}));
	const presentation = $derived(
		livePresentation({
			familyStates: live.familyStates,
			families: LIVE_FAMILIES,
			locale,
			page: 'map',
			selection: session.selected,
			vehicleCount: live.vehicles?.vehicles.length ?? null,
		}),
	);

	let viewMode = $state<'map' | 'reports'>('map');
	let reportsPaneOpen = $state(false);
	let reportsScrollTop = $state(0);
	let reportsReturnFocus = $state<string | null>(null);
	let reportCamera = $state.raw<MapReportCamera | null>(null);
	let pendingViewHint: MapViewHint | null = null;
	let ingestedViewHint = false;
	const reportsOpen = $derived(desktop.current ? reportsPaneOpen : viewMode === 'reports');
	const viewSwitchValue = $derived<'map' | 'reports'>(reportsOpen ? 'reports' : 'map');
	const reportsCopy = $derived(mapReportsCopy(locale));
	const providerName = $derived(
		v1.provider?.labels[locale].operator ?? manifest.city ?? manifest.provider,
	);
	const reportView = $derived.by(() => {
		const health = live.familyStates.vehicles.health;
		return buildMapReportView({
			source: live.vehicles,
			health: {
				retained: health.retained,
				failing:
					health.state === 'retrying' ||
					health.state === 'failed-no-data' ||
					health.notice === 'refresh-unavailable',
				stale: health.isStale,
			},
			filter: filters.state,
			alertVehicleIds,
			camera: reportCamera,
			serverNow: dataClock.serverNow,
			staleCutoffS: liveTimingFor(manifest).staleCutoffS,
			providerId: manifest.provider,
			providerName,
			locale,
			timeZone: manifest.tz,
			attribution: manifest.attribution,
			filters: mapReportFilterTokens(filters.state),
		});
	});
	const reportSnapshotId = $derived(reportView.kind === 'ready' ? reportView.model.identity : '');
	const reportFilterLabels = $derived(
		mapReportFilterLabels(filters.state, locale, {
			line: (id) => lineLabel(id, session.routesIndex),
			stop: (id) => {
				const stop = session.stops.find((candidate) => candidate.id === id);
				return stop ? stopDisplayName(stop.name) : id;
			},
		}),
	);
	const reportsLiveViewHref = $derived(
		buildMapReportLiveViewHref(
			urlCoordinator.currentUrl(),
			filters.state,
			reportCamera,
			manifest.provider,
		),
	);

	function setView(next: 'map' | 'reports'): void {
		if (desktop.current) {
			if (next === 'reports') {
				if (detailOpen) closeDetail();
				reportsPaneOpen = true;
			} else {
				reportsPaneOpen = false;
			}
			return;
		}
		viewMode = next;
		if (next === 'reports') reportsReturnFocus = null;
	}

	function closeReports(): void {
		if (desktop.current) reportsPaneOpen = false;
		else viewMode = 'map';
	}

	function focusMapViewSwitch(): void {
		heroEl
			?.querySelector<HTMLElement>(
				'[data-slot="map-view-choice"] [role="radio"][aria-checked="true"]',
			)
			?.focus({ preventScroll: true });
	}

	async function copyReportLink(): Promise<boolean> {
		const href = reportsLiveViewHref;
		if (!href || typeof navigator === 'undefined' || !navigator.clipboard) return false;
		try {
			await navigator.clipboard.writeText(href);
			return true;
		} catch {
			return false;
		}
	}

	function selectReportVehicle(id: string): void {
		reportsReturnFocus = id;
		commitPickedSelection({ kind: 'vehicle', id });
		detailCollapsed = detailWidthPx === 56;
	}

	$effect(() => {
		const routes = session.loadedRoutes;
		untrack(() => {
			for (const route of routes) if (route) vehicleMotion.remember(route);
		});
	});
	function commitPickedSelection(next: MapSelection) {
		session.select(next, 'pick');
	}
	function selectPickedFeature(next: MapSelection) {
		commitPickedSelection(next);
		detailCollapsed = detailWidthPx === 56;
		// A vehicle pick opens its detail in place; only route and stop picks move the camera.
		if (next.kind !== 'vehicle') focusSelection(next);
	}
	function closeDetail() {
		session.close();
		detailCollapsed = detailWidthPx === 56;
		if (reportsOpen) {
			const id = reportsReturnFocus;
			reportsReturnFocus = null;
			void tick().then(() => {
				const pane = heroEl?.querySelector<HTMLElement>('[data-slot="map-reports"]');
				const target =
					(id && pane?.querySelector<HTMLElement>(`[data-report-select="${CSS.escape(id)}"]`)) ||
					pane?.querySelector<HTMLElement>('.map-reports-title');
				target?.focus({ preventScroll: true });
			});
		}
	}
	const selectFromDetail = (next: MapSelection) => {
		session.select(next, 'detail');
		focusSelection(next);
	};

	const applyDetailFilter = session.applyFilter;
	const selectAlertRelated = session.selectAlert;
	const nearbyStops = $derived<WithDistance<SlimStopEntry>[]>(
		nearMeController.origin ? nearestStops(nearMeController.origin, stopList, 5, 1_200) : [],
	);

	function focusSelection(selection: MapSelection, target: MapLibreMap | null = map): boolean {
		if (recovering) {
			cameraIntents.state({ kind: 'selection', selection });
			return true;
		}
		if (selection.kind === 'stop') return focusStop(selection.id, target);
		if (selection.kind === 'vehicle') return focusVehicle(selection.id, target);
		return focusRoute(selection.id, target);
	}

	function focusStop(id: string, target: MapLibreMap | null = map): boolean {
		const stop = stopList.find((s) => s.id === id);
		if (!stop) return false;
		return focusCoordinate(target, [stop.lon, stop.lat], 16);
	}

	function focusVehicle(id: string, target: MapLibreMap | null = map): boolean {
		const vehicle = (live.vehicles?.vehicles ?? []).find((v) => v.id === id);
		if (!vehicle) return false;
		return focusCoordinate(target, [vehicle.lon, vehicle.lat], 16);
	}

	function focusRoute(id: string, target: MapLibreMap | null = map): boolean {
		const route = routeList.find((r) => r.id === id);
		if (!route) return false;
		return fitRouteBounds(target, route);
	}

	$effect(() => {
		const pending = focusController.pending;
		if (recovering || !map || !pending) return;
		if (!session.focusReady(pending)) return;
		focusController.consumeOnce(focusSelection);
	});

	function focusNearMeOrigin(origin: NearMeOrigin): void {
		const coord: [number, number] = [origin.lon, origin.lat];
		const minZoom = zoomForNearMePrecision(origin.precision);
		if (recovering) cameraIntents.state({ kind: 'point', coord, minZoom });
		else focusCoordinate(map, coord, minZoom);
	}

	function selectNearbyStop(stop: WithDistance<SlimStopEntry>): void {
		commitPickedSelection({ kind: 'stop', id: stop.id });
		detailCollapsed = detailWidthPx === 56;
		if (recovering)
			cameraIntents.state({ kind: 'point', coord: [stop.lon, stop.lat], minZoom: 15 });
		else focusCoordinate(map, [stop.lon, stop.lat], 15);
	}

	function onMapReady(m: MapLibreMap, reportSetupFailure?: () => void): void {
		const wasRecovering = recovering;
		hasFirstIdle = false;
		runtime.ready(m, reportSetupFailure);
		if (wasRecovering) {
			recovering = false;
			cameraIntents.replay((intent) => {
				if (focusController.pending) focusController.consumeOnce(() => {});
				if (intent.kind === 'point') focusCoordinate(m, intent.coord, intent.minZoom);
				else focusSelection(intent.selection, m);
			});
		} else {
			const hint = pendingViewHint;
			pendingViewHint = null;
			// An explicit focus or near-me search is this page's own intent and outranks the link.
			if (hint && !focusController.pending && !nearMeController.origin) {
				m.jumpTo({
					center: [hint.center[0], hint.center[1]],
					zoom: hint.zoom,
					bearing: hint.bearing,
					pitch: hint.pitch,
				});
			}
			nearMeController.refocus();
		}
		onready?.();
	}

	function onMapRecovering(): void {
		const focused = document.activeElement;
		const ownedFocus = focused instanceof HTMLElement && heroEl?.contains(focused) ? focused : null;
		recoveryFocusTarget =
			ownedFocus && !ownedFocus.closest('[data-map-runtime]') ? ownedFocus : null;
		ownedFocus?.blur();
		recovering = true;
		cameraIntents.state(focusController.pending ? { kind: 'url' } : null);
		onrecovering?.();
	}

	function onMapIdle(): void {
		hasFirstIdle = true;
		const focused = recoveryFocusTarget;
		recoveryFocusTarget = null;
		onidle?.();
		if (focused) {
			void tick().then(() => {
				if (
					!recovering &&
					focused.isConnected &&
					heroEl?.contains(focused) &&
					document.activeElement === document.body &&
					!focused.closest('[inert]')
				) {
					focused.focus({ preventScroll: true });
				}
			});
		}
	}

	function onMapFailure(failure: MapStageFailure | null): void {
		mapFailure = failure;
		onfailure?.(failure);
	}

	const motionFrame = $derived(
		vehicleMotion.read(live.vehicles, {
			preference: motionMode.current,
			reducedMotion: $prefersReducedMotion,
			ready: hasFirstIdle,
			stale: live.familyStates.vehicles.health.isStale,
			ttlS: manifest.files.live.ttl_s,
			sourceLagS: liveTimingFor(manifest).sourceLagS,
			stops: stopList,
		}),
	);

	// Read intent before the map exists so Estimated position can prefetch shapes.
	$effect(() => {
		void motionFrame;
	});

	function readMapFeed(): MapRuntimeFeed {
		const filter = filters.state;
		return {
			routes: {
				items: routeLineRoutes,
				selected: selectedRouteLine,
			},
			vehicles: {
				...motionFrame,
				filter,
				alertIds: alertVehicleIds,
				selectedId: selectedVehicleId,
			},
			stops: {
				items: stopList,
				filter,
				alertIds: session.alertStopIds,
				selectedId: selectedStopId,
			},
			nearTarget: {
				target: nearMeController.origin,
			},
		};
	}

	$effect(() => {
		const el = heroEl;
		if (!el) return;
		const open = desktop.current && (detailOpen || reportsPaneOpen);
		const dispose = publishRailOffset(el, detailWidthPx, open, detailCollapsed, detailDragging);
		return () => releaseMapOwner(dispose);
	});

	// Opening/resizing detail surfaces refits only while the camera is fit-owned.
	$effect(() => {
		const instance = map;
		void detailOpen;
		void reportsPaneOpen;
		void detailWidthPx;
		void detailCollapsed;
		void desktop.current;
		if (!instance) return;
		let disposed = false;
		const update = () => {
			if (disposed) return;
			if (!heroEl) return;
			const inset = measureMapFocusInset({ getContainer: () => heroEl! });
			const width = (selector: string) =>
				heroEl!.querySelector(selector)?.getBoundingClientRect().width ?? 0;
			// On desktop the title block shares the controls column; banners keep clear of both.
			const controlsWidth = Math.max(
				width('.map-filter-panel'),
				desktop.current ? width('.map-head') : 0,
			);
			heroEl.style.setProperty('--map-controls-width', controlsWidth + 'px');
			if (!inset.containerWidth || !inset.containerHeight) return;
			if (import.meta.env.MODE === 'e2e')
				heroEl.dataset.cameraPadding = JSON.stringify(inset.fitPadding);
			// Without published bounds MapStage constructs no map; never refit a fabricated camera.
			if (!framing) return;
			camera.update(instance, {
				...framing,
				size: { width: inset.containerWidth, height: inset.containerHeight },
				fitPadding: inset.fitPadding,
			});
		};
		const observer = new ResizeObserver(update);
		void tick().then(() => {
			if (disposed) return;
			for (const el of document.querySelectorAll(
				'[data-slot="map-detail-overlay"], .map-head, .map-filter-panel, [data-slot="map-legend-card"], [data-slot="map-legend-fab"], .map-filter-pill-container, .map-near, [data-slot="bottom-sheet"]',
			))
				observer.observe(el);
			update();
		});
		return () => {
			disposed = true;
			observer.disconnect();
		};
	});
	function toggleDetailCollapsed(): void {
		if (detailCollapsed && detailWidthPx === 56) detailWidthPx = 400;
		detailCollapsed = !detailCollapsed;
		if (detailCollapsed) detailWidthPx = 56;
	}
</script>

{#snippet mapBody()}
	<MapStage
		{camera}
		class="map-hero-stage"
		basemapLoader={({ signal }) => getBasemap({ signal })}
		theme={theme.current}
		center={framing?.center}
		bounds={framing?.bounds}
		maxBounds={framing?.maxBounds}
		fitPadding={framing?.fitPadding}
		onready={onMapReady}
		onorientation={onMapOrientation}
		onrecovering={onMapRecovering}
		onidle={onMapIdle}
		onstyleload={runtime.styleLoad}
		onthemerepaint={runtime.repaint}
		onerror={onMapFailure}
		onbeforeremove={runtime.release}
		customAttribution={providerAttribution(manifest.provider, manifest.attribution, locale)}
		locale={{
			'Map.Title': t.mapCanvasLabel,
			'AttributionControl.ToggleAttribution': t.attributionToggle,
		}}
		label={t.mapLabel}
	/>
{/snippet}

{#snippet detailPanel()}
	<!-- prettier-ignore -->

	<RightPanel
		locale={locale}
		identity={detailIdentity}
		footer={detailFooter}
		navigation={detailNavigation}
		surfaceKey={detailSurfaceKey}
		canGoBack={false}
		onback={session.back}
		onclose={closeDetail}
		collapsed={detailCollapsed}
		ontogglecollapse={toggleDetailCollapsed}
		resizable
 selectionKind={session.selected?.kind}
	>
		{#if selectedDetail}
			<MapSelectionDetail {occupancyAvailable}
				detail={selectedDetail}
				alertsStale={live.familyStates.alerts.health.notice !== null}
				alertsAgeSeconds={live.familyStates.alerts.health.ageSeconds}
				locale={locale}
				timeZone={v1.manifest.tz}
				notReporting={selectedVehicleAbsence}
				selectionPresence={selectionPresence}
				selectionSourceHealth={selectionSourceHealth}
				onrefresh={live.refresh}
				onselect={selectFromDetail}
				onpreview={(next) => void session.setHovered(next)}
				onfilter={applyDetailFilter}
				onalertselect={selectAlertRelated}
			/>
		{/if}
	</RightPanel>
{/snippet}

{#snippet detailNavigation()}
	<MapDetailNavigation
		{locale}
		{session}
		desktop={desktop.current}
		onfocus={() => {
			if (session.selected) focusSelection(session.selected);
		}}
	/>
{/snippet}

{#snippet detailIdentity()}
	<!-- prettier-ignore -->

	<MapSelectionDetail
		detail={selectedDetail}
		locale={locale}
		presentation="identity"
	/>
{/snippet}

{#snippet detailFooter()}
	<!-- prettier-ignore -->

	<MapSelectionDetail
		detail={selectedDetail}
		locale={locale}
		presentation="action"
		onfilter={applyDetailFilter}
	/>
{/snippet}

{#snippet reportsPanelContent(presentation: 'pane' | 'overlay')}
	<MapReportsPanel
		{locale}
		view={reportView}
		{providerName}
		filterLabels={reportFilterLabels}
		line={(id) => lineLabel(id, session.routesIndex)}
		snapshotId={reportSnapshotId}
		liveViewHref={reportsLiveViewHref}
		{presentation}
		copyLiveView={copyReportLink}
		onselect={selectReportVehicle}
		onclose={closeReports}
		bind:scrollTop={reportsScrollTop}
	/>
{/snippet}

{#snippet reportsPane()}
	<!-- prettier-ignore -->

	<RightPanel
		locale={locale}
		title={reportsCopy.reportsTitle}
		surfaceKey="map-reports"
		canGoBack={false}
		onclose={closeReports}
		collapsed={detailCollapsed}
		ontogglecollapse={toggleDetailCollapsed}
		resizable
		selectionKind="reports"
	>
		{@render reportsPanelContent('pane')}
	</RightPanel>
{/snippet}

{#snippet motionHeader(collapsed: boolean)}
	<MapMotionControl {locale} copy={t} {collapsed} />
{/snippet}
{#snippet mapControls(opts?: { collapsible?: boolean })}
	<MapFilters
		{occupancyAvailable}
		store={filters}
		{alertsAvailable}
		{locale}
		routes={session.routesIndex}
		stops={session.stops}
		collapsible={opts?.collapsible ?? true}
		controlsMode={true}
		header={motionHeader}
	/>
{/snippet}

{#snippet mapRetry()}
	{#if mapFailure}
		<Button type="button" size="sm" class="min-h-11" onclick={() => void mapFailure?.retry()}>
			{t.mapRetry}
		</Button>
	{/if}
{/snippet}

{#snippet mapSurface()}
	<div
		class="map-surface"
		inert={!desktop.current && viewMode === 'reports' ? true : undefined}
		data-slot="map-surface"
	>
		<MapSurfaceCanvasLayer {mapBody} />

		{#if mapFailure}
			<div class="map-stage-error">
				<StateNotice
					title={t.mapErrorTitle}
					body={t.mapErrorBody}
					glyph="!"
					tone="error"
					presentation="card"
					role="alert"
					aria-live="assertive"
					action={mapRetry}
				/>
			</div>
		{:else}
			<MapOverlayChrome
				{orientation}
				{northStatus}
				onnorth={turnNorth}
				{locale}
				{t}
				{presentation}
				bind:nearMeOpen={nearMeController.open}
				bind:nearMeQuery={nearMeController.query}
				nearMeLoading={nearMeController.loading}
				nearMeError={nearMeController.error}
				nearMeOrigin={nearMeController.origin}
				{nearbyStops}
				onuselocation={nearMeController.useLocation}
				onsearch={nearMeController.search}
				onsuggestion={nearMeController.selectSuggestion}
				onstopselect={selectNearbyStop}
				onclear={nearMeController.clear}
				isDesktop={desktop.current}
				filtersStore={filters}
				staleCutoffS={liveTimingFor(manifest).staleCutoffS}
				{detailOpen}
				{hoverPeek}
				detailSelection={desktop.current && detailOpen && !detailCollapsed
					? session.selected
					: null}
				viewMode={viewSwitchValue}
				onviewchange={setView}
				controls={mapControls}
			/>
		{/if}
	</div>
{/snippet}

<div
	class="map-hero"
	data-ripple-exempt
	data-selection-presence={selectionPresence}
	data-selection-source-health={selectionSourceHealth}
	data-motion-stale={live.familyStates.vehicles.health.isStale}
	data-motion-tick-key={runtime.processedMotion?.tickKey}
	data-motion-vehicle-count={runtime.processedMotion?.vehicleCount}
	bind:this={heroEl}
	bind:clientWidth={mapWidthPx}
	data-map-view={viewSwitchValue}
>
	{@render mapSurface()}

	{#if !desktop.current && viewMode === 'reports'}
		{@render reportsPanelContent('overlay')}
	{/if}

	{#if desktop.current && detailOpen}
		<MapDetailOverlay
			{locale}
			bind:widthPx={detailWidthPx}
			bind:collapsed={detailCollapsed}
			bind:dragging={detailDragging}
			resizeAria={detailResizeAria}
			{detailPanel}
		/>
	{:else if desktop.current && reportsPaneOpen}
		<MapDetailOverlay
			{locale}
			bind:widthPx={detailWidthPx}
			bind:collapsed={detailCollapsed}
			bind:dragging={detailDragging}
			resizeAria={detailResizeAria}
			detailPanel={reportsPane}
		/>
	{/if}

	{#if detailOpen && !desktop.current}
		<MapMobileDetailSheet
			{occupancyAvailable}
			bind:open={
				() => session.detailOpen,
				(next) => {
					if (next) session.detailOpen = true;
					else closeDetail();
				}
			}
			{locale}
			identity={detailIdentity}
			timeZone={v1.manifest.tz}
			footer={detailFooter}
			navigation={detailNavigation}
			surfaceKey={detailSurfaceKey}
			canGoBack={false}
			onback={session.back}
			{selectedDetail}
			alertsStale={live.familyStates.alerts.health.notice !== null}
			alertsAgeSeconds={live.familyStates.alerts.health.ageSeconds}
			notReporting={selectedVehicleAbsence}
			{selectionPresence}
			{selectionSourceHealth}
			onrefresh={live.refresh}
			onselect={selectFromDetail}
			onpreview={(next) => void session.setHovered(next)}
			onfilter={applyDetailFilter}
			onalertselect={selectAlertRelated}
		/>
	{/if}
</div>

<style>
	.map-hero {
		position: relative;
		width: 100%;
		height: 100%;
		overflow: hidden;
		background: var(--background);
		--app-right-detail-offset: var(--size-detail-panel);
		--map-detail-offset: 0rem;
		--map-mobile-control-bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
		--map-north-clearance: calc(
			var(--map-mobile-control-bottom) + 2.75rem + 0.75rem + 1.75rem + 0.75rem + 2.75rem + 0.75rem
		);
		--z-map-behind: -1;
		--z-map-canvas: 1;
		--z-map-popover-behind: 2;
		--z-map-scrim: 5;
		--z-map-overlay: 10;
		--z-map-filter: 12;
		--z-map-banner-content: 13;
		--z-map-detail: 24;
		--z-map-detail-panel: 32;
	}

	.map-surface {
		position: absolute;
		inset: 0;
		overflow: hidden;
	}

	.map-stage-error {
		position: absolute;
		z-index: var(--z-map-detail);
		inset: 0;
		display: grid;
		place-items: center;
		padding: 1rem;
		background: color-mix(in srgb, var(--background) 88%, transparent);
	}

	.map-stage-error :global(.state-notice) {
		width: min(100%, 30rem);
	}
</style>
