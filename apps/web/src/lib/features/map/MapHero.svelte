<script lang="ts">
	import { datedProviderAttribution, providerAttribution } from '#lib/i18n/providerAttribution.ts';
	import { liveTimingFor } from '#lib/components/map/liveTiming.ts';
	import { liveReader } from '#lib/v1/adapter/index.ts';
	import { provideLiveAbsenceContext } from '#lib/site/absence.ts';
	import { measureMapFocusInset } from './mapFocusInset';
	import { providerHasAlerts } from '#lib/v1/providers.ts';
	import { lineIsScheduleOnly } from '#lib/site/providerCapabilities.ts';
	import { getContext, onMount, tick, untrack, type Snippet } from 'svelte';
	import {
		mapPanelOpenContext,
		mapRecordSourceDateContext,
	} from '#lib/site/mapRecordSourceDate.ts';
	import { page } from '$app/state';
	import { SegmentedChoice, Stamp } from '@yesid/ui/brand';
	import { MapFrame } from '@yesid/ui/map';
	import { Card } from '@yesid/ui/card';
	import { Sheet, SheetContent, SheetTitle, type SheetDetent } from '@yesid/ui/sheet';
	import { sheetCopy } from '#lib/components/shell/sheet.copy.ts';
	import MaximizeIcon from '@lucide/svelte/icons/maximize';
	import { recordStamp } from '#lib/site/presenter.ts';
	import { liveStamp, stampText } from '#lib/v1/stamp.ts';
	import RefreshButton from '#lib/components/shell/RefreshButton.svelte';
	import { formatRelativeSeconds } from '#lib/utils/time.ts';
	import {
		FrameControlsExtensionContext,
		type RegisterFrameControlsExtension,
	} from '#lib/components/shell/FrameControls.svelte';
	import { colourDimension } from '#lib/components/map/vehicleLayer.ts';
	import MapFrameLegend from './MapFrameLegend.svelte';
	import MapLegendControl from './MapLegendControl.svelte';
	import MapInView from './MapInView.svelte';
	import MapFeedStallBanner from './MapFeedStallBanner.svelte';
	import MapNearMeControl from './MapNearMeControl.svelte';
	import MapNorthControl from './MapNorthControl.svelte';
	import MapHoverPeek from './MapHoverPeek.svelte';
	import { mapLegend, railLegendName } from './mapLegend';
	import { peekRepeatsDetail } from './mapHoverPeek';
	import { frameClock, parseFrameState } from '#lib/site/frameState.ts';
	import { mapLayerFor } from '#lib/site/mapFrame.ts';
	import MapRecordPanel from './MapRecordPanel.svelte';
	import type { RecordMapLayer } from './recordMap';
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
	import type { ScheduleEdition } from '#lib/search/searchIndex.ts';
	import { createFilterStore, fromSearchParams } from '#lib/filters/index.ts';
	import { nearTargetFromSearchParams } from '#lib/search/mapNear.ts';
	import { parseMapFocus } from '#lib/search/mapFocus.ts';
	import { hasOccupancy, lineLabel } from '#lib/site/transitDisplay.ts';
	import { MapStage, nearestStops, type WithDistance } from '#lib/components/map/index.ts';
	import { createVehicleMotion } from './vehicleMotion';
	import { getMapRoutes } from '#lib/v1/repositories/scheduleShapes.ts';
	import { motionMode } from '#lib/stores/index.ts';
	import { prefersReducedMotion } from '@yesid/motion/stores/reducedMotion';
	import MapFilters from './MapFilters.svelte';
	import MapMotionControl from './MapMotionControl.svelte';
	import { detailStopName } from './mapSelectionDetail.logic';
	import { MAP_SELECTION_DETAIL_COPY } from './mapSelectionDetail.copy';
	import MapSelectionSummary from './MapSelectionSummary.svelte';
	import MapSurfaceCanvasLayer from './MapSurfaceCanvasLayer.svelte';
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
	import { createMapRuntime, type MapRuntimeFeed } from './mapRuntime.svelte';
	import { createMapSelectionSession, type MapSelection } from './mapSelectionSession.svelte';
	import * as ownerCleanup from './mapOwnerCleanup';
	import { captureMapReportCamera, type MapReportCamera } from './mapReportCamera';
	import { buildMapReportView, mapReportFilterTokens, type MapReportRow } from './mapReports';
	import { buildMapReportLiveViewHref } from './mapReportsLink';
	import { parseMapViewHint, mapViewHintWithinRuntime, type MapViewHint } from './mapViewHint';

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
	const timeZone = v1.provider?.timezone ?? manifest.tz;
	const city = v1.provider?.labels[locale].city ?? manifest.city ?? manifest.provider;
	const t = mapCopy(locale, city);
	const tr = (en: string, fr: string) => (locale === 'fr' ? fr : en);

	const alertsAvailable = providerHasAlerts(v1.provider);
	function readMapFilters(params: URLSearchParams) {
		const state = fromSearchParams(params);
		return alertsAvailable ? state : { ...state, alerts: [] };
	}

	let mapWidthPx = $state(1280);
	let remWidth = $state(16);
	const wide = $derived(
		mapWidthPx > 0 && remWidth > 0 ? mapWidthPx >= 64 * remWidth : desktop.current,
	);

	let heroEl = $state<HTMLDivElement | null>(null);
	const framing = $derived(initialCamera(v1, mapWidthPx, wide));
	const currentMapHref = () => (page.shallow?.url ?? page.url).href;
	const urlCoordinator = createMapUrlCoordinator(new URL(currentMapHref()), goto);
	const filters = createFilterStore(
		readMapFilters(new URL(currentMapHref()).searchParams),
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
		const url = new URL(currentMapHref());
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
		hasOccupancy(v1.provider?.inputs.occupancy, live.vehicles?.vehicles ?? []),
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
	const vehicleMotion = createVehicleMotion(getMapRoutes, {
		now: () => untrack(() => clock.serverNow),
		continuous: () => untrack(() => clock.serverNowContinuousMs()),
	});
	const session = createMapSelectionSession({
		get nameSeparators() {
			return v1.provider?.name_separators;
		},
		live,
		repositories: { getRoute, getStop, getStopsIndexSlim, getRoutesIndex },
		filters,
		locale,
		timeZone,
		staleCutoffS: liveTimingFor(manifest).staleCutoffS,
		serverNow: () => dataClock.serverNow,
		alertsAvailable,
		scheduleOnly: (id, type) => lineIsScheduleOnly(page.data.provider, id, type),
		drawRoutes: () => !isRecordLayer,
		setTripScope: live.setTripScope,
	});
	const mapVehicles = $derived(
		live.vehicles && {
			...live.vehicles,
			vehicles: live.vehicles.vehicles.filter(
				(vehicle) => !vehicle.route || !session.scheduledRouteIds.includes(vehicle.route),
			),
		},
	);
	const runtime = createMapRuntime({
		selection: session,
		readFeed: readMapFeed,
		onpick: selectPickedFeature,
	});
	const map = $derived(runtime.map);
	const recordUrl = $derived(new URL(currentMapHref()));
	const recordLayer = $derived(mapLayerFor(recordUrl.searchParams));
	const isRecordLayer = $derived(recordLayer !== 'live');
	let recordSourceDate = $state<string | null>(null);
	const publishRecordSourceDate = getContext<((date: string | null) => void) | undefined>(
		mapRecordSourceDateContext,
	);
	$effect(() => {
		publishRecordSourceDate?.(isRecordLayer ? recordSourceDate : null);
		return () => publishRecordSourceDate?.(null);
	});
	const datedMapNotice = $derived(
		datedProviderAttribution(
			v1.provider,
			locale,
			isRecordLayer ? recordSourceDate : live.sourceDate,
		),
	);
	const recordOptions: { key: Exclude<RecordMapLayer, 'live'>; label: string }[] = [
		{ key: 'stops', label: locale === 'fr' ? 'Arrêts' : 'Stops' },
		{ key: 'corridors', label: 'Corridors' },
	];
	const recordPeriod = $derived(
		parseFrameState(
			recordUrl.searchParams,
			frameClock(v1.provider ?? (timeZone ? { timezone: timeZone } : null)),
		).period,
	);
	const recordLine = $derived(
		recordUrl.searchParams.get('recordLine') ??
			(session.selected?.kind === 'route'
				? session.selected.id
				: filters.routes.size === 1
					? [...filters.routes][0]
					: '') ??
			'',
	);
	const recordDirection = $derived(
		recordUrl.searchParams.get('recordDirection') ??
			(session.selected?.kind === 'route' &&
			session.selected.id === recordLine &&
			session.selected.direction != null
				? String(session.selected.direction)
				: ''),
	);

	function changeRecordLayer(layer: Exclude<RecordMapLayer, 'live'>): void {
		if (layer === recordLayer) return;
		const url = urlCoordinator.currentUrl();
		url.searchParams.set('mapLayer', layer);
		void urlCoordinator.goto(url.pathname + url.search, MAP_URL_REWRITE);
	}

	function changeRecordScope(line: string, direction: string): void {
		const url = urlCoordinator.currentUrl();
		url.searchParams.set('recordLine', line);
		url.searchParams.set('recordDirection', direction);
		void urlCoordinator.goto(url.pathname + url.search, MAP_URL_REWRITE);
	}

	// One camera capture per settled move or resize. Animation frames never rebuild the list.
	$effect(() => {
		const instance = map;
		if (!instance) {
			reportCamera = null;
			return;
		}
		// Listener registration and projection read the map's own state; only `map` is a dependency.
		return untrack(() => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const capture = () => {
				timer = undefined;
				reportCamera = captureMapReportCamera(instance);
			};
			const schedule = () => {
				if (timer === undefined) timer = setTimeout(capture, 150);
			};
			instance.on('moveend', schedule);
			instance.on('resize', schedule);
			capture();
			return () => {
				instance.off('moveend', schedule);
				instance.off('resize', schedule);
				if (timer !== undefined) clearTimeout(timer);
			};
		});
	});

	const detailOpen = $derived(session.detailOpen && !isRecordLayer);
	let inViewOpen = $state(false);
	let inViewDetent = $state('half');
	const detents: readonly SheetDetent[] = [
		{ id: 'peek', size: '168px', label: sheetCopy[locale].peek },
		{ id: 'half', size: '50%', label: sheetCopy[locale].half },
		{ id: 'full', size: '90%', label: sheetCopy[locale].full },
	];
	let liveListLimit = $state(12);
	let mobileScrollTop = 0;
	let listScrollBeforeSelection: number | null = null;
	let restoreListTrigger = false;
	let inViewTrigger = $state<HTMLButtonElement | null>(null);
	let detailBack = $state<HTMLButtonElement | null>(null);
	let inViewBody = $state<HTMLDivElement | null>(null);
	let returnVehicle = $state<string | null>(null);
	const reportPanelOpen = getContext<((open: boolean) => void) | undefined>(mapPanelOpenContext);
	$effect(() => {
		reportPanelOpen?.(!wide && (inViewOpen || detailOpen));
		return () => reportPanelOpen?.(false);
	});
	const stopList = $derived(session.stops);
	let mapDirections = $state.raw<ScheduleEdition['route_directions']>();
	onMount(() => {
		let active = true;
		void import('#lib/v1/adapter/r2.static.ts')
			.then(({ getMapRouteDirections }) => getMapRouteDirections({ providerId: manifest.provider }))
			.then(
				(directions) => {
					if (active) mapDirections = directions;
				},
				() => {},
			);
		return () => {
			active = false;
		};
	});
	function reportHeadsign(row: MapReportRow): string | null {
		if (!row.routeId || row.directionId == null) return null;
		const names = new Set(
			mapDirections?.[row.routeId]
				?.filter((direction) => direction.dir === row.directionId)
				.map((direction) => direction.headsign)
				.filter(Boolean),
		);
		return names.size === 1 ? (names.values().next().value ?? null) : null;
	}
	const selectedDetail = $derived(session.detail);
	const selectionCopy = $derived(MAP_SELECTION_DETAIL_COPY[locale]);
	const selectionPresence = $derived(session.presence);
	const selectionSourceHealth = $derived(session.sourceHealth);
	const selectedVehicleAbsence = $derived(session.vehicleAbsence);
	const hoverPeek = $derived(session.hoverPeek);
	const routeList = $derived(session.routeList);
	const railName = $derived(railLegendName(locale, page.data.provider, session.routesIndex));
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
			timeZone,
			locale,
			page: 'map',
			selection: session.selected,
			vehicleCount: live.vehicles?.vehicles.length ?? null,
		}),
	);
	const liveTime = $derived(
		liveStamp({ ...presentation.stamp, notResponding: presentation.stamp.ageLabel != null }),
	);
	const liveStampLabel = $derived(
		!wide && remWidth >= 24 && liveTime.ageSeconds !== null && liveTime.state === 'current'
			? `${tr('Live', 'En direct')} · ${formatRelativeSeconds(liveTime.ageSeconds, locale)}`
			: stampText(liveTime, locale, timeZone),
	);

	let reportCamera = $state.raw<MapReportCamera | null>(null);
	let pendingViewHint: MapViewHint | null = null;
	let ingestedViewHint = false;
	let recordCount = $state<number | null>(null);
	const colourBy = $derived(colourDimension(filters.state));
	const legendDetails = $derived(
		mapLegend(locale, { colourBy, staleCutoffS: liveTimingFor(manifest).staleCutoffS }),
	);
	const title = $derived(
		isRecordLayer ? tr('Map of the record', 'Carte du bilan') : tr('Live map', 'Carte en direct'),
	);
	const viewLabel = tr('What is in view', 'Ce qui est en vue');
	const providerName = $derived(
		v1.provider?.labels[locale].operator ?? manifest.city ?? manifest.provider,
	);
	const reportView = $derived.by(() => {
		const health = live.familyStates.vehicles.health;
		return buildMapReportView({
			source: mapVehicles,
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
			alertPublication: live.alerts,
			alertHealth: {
				loading: live.familyStates.alerts.phase === 'loading',
				retained: live.familyStates.alerts.health.retained,
				failing:
					live.familyStates.alerts.health.state === 'retrying' ||
					live.familyStates.alerts.health.state === 'failed-no-data' ||
					live.familyStates.alerts.health.notice === 'refresh-unavailable',
				stale: live.familyStates.alerts.health.isStale,
			},
			camera: reportCamera,
			serverNow: dataClock.serverNow,
			staleCutoffS: liveTimingFor(manifest).staleCutoffS,
			providerId: manifest.provider,
			providerName,
			locale,
			timeZone,
			attribution:
				datedProviderAttribution(v1.provider, locale, live.sourceDate) ?? manifest.attribution,
			filters: mapReportFilterTokens(filters.state),
		});
	});
	const inViewCount = $derived(
		isRecordLayer ? recordCount : reportView.kind === 'ready' ? reportView.model.inViewCount : null,
	);
	const liveViewHref = $derived(
		!isRecordLayer
			? buildMapReportLiveViewHref(recordUrl, filters.state, reportCamera, manifest.provider)
			: null,
	);

	function selectReportVehicle(id: string): void {
		camera.interact();
		returnVehicle = id;
		const scroller = inViewScroller();
		listScrollBeforeSelection = scroller?.scrollTop ?? null;
		commitPickedSelection({ kind: 'vehicle', id });
		void tick().then(() => {
			if (wide && scroller) scroller.scrollTop = 0;
			detailBack?.focus({ preventScroll: wide });
		});
	}
	function inViewScroller(): HTMLElement | null {
		return (
			inViewBody?.closest('[data-slot="map-details"], [data-slot="bottom-sheet-body"]') ?? null
		);
	}
	function restoreInViewScroll(node: HTMLDivElement): void {
		node.scrollTop = mobileScrollTop;
	}
	$effect(() => {
		const routes = session.loadedRoutes;
		untrack(() => {
			for (const route of routes) {
				if (route?.directions?.some((direction) => direction.shape)) vehicleMotion.remember(route);
			}
		});
	});
	function commitPickedSelection(next: MapSelection) {
		session.select(next, 'pick');
	}
	function selectPickedFeature(next: MapSelection) {
		if (isRecordLayer) return;
		if (next.kind === 'vehicle') camera.interact();
		commitPickedSelection(next);
		// A vehicle pick opens its detail in place; only route and stop picks move the camera.
		if (next.kind !== 'vehicle') focusSelection(next);
	}
	function closeDetail() {
		session.close();
		const id = returnVehicle;
		returnVehicle = null;
		if (!id) return;
		const scroll = listScrollBeforeSelection;
		listScrollBeforeSelection = null;
		void tick().then(() => {
			const scroller = inViewScroller();
			if (scroller && scroll !== null) scroller.scrollTop = scroll;
			const row = inViewBody?.querySelector<HTMLElement>(
				`[data-in-view-vehicle="${CSS.escape(id)}"]`,
			);
			const heading = inViewBody?.querySelector<HTMLElement>('[data-map-in-view-title]');
			(row ?? heading)?.focus({ preventScroll: Boolean(row) });
		});
	}
	function clearDetailOnEscape(event: KeyboardEvent) {
		if (event.key !== 'Escape' || !detailOpen || event.defaultPrevented) return;
		if (!(event.target instanceof HTMLElement) || !ownsMapFocus(event.target)) return;
		event.preventDefault();
		closeDetail();
	}
	const applyDetailFilter = session.applyFilter;
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
			if (
				hint &&
				framing &&
				!focusController.pending &&
				!nearMeController.origin &&
				mapViewHintWithinRuntime(hint, m)
			) {
				const canvas = m.getCanvas();
				const inputs = {
					...framing,
					size: { width: canvas.clientWidth, height: canvas.clientHeight },
					fitPadding: measureMapFocusInset(m).fitPadding,
				};
				// Restore constraints around the copied view before setting its centre.
				// A different initial title height must not clamp the link to the new fit.
				camera.attach(m, inputs, {
					...camera.capture(m, inputs),
					center: [hint.center[0], hint.center[1]],
					zoom: hint.zoom,
					bearing: hint.bearing,
					pitch: hint.pitch,
					owner: 'user',
				});
			}
			nearMeController.refocus();
		}
		onready?.();
	}

	function onMapRecovering(): void {
		const focused = document.activeElement;
		const ownedFocus = focused instanceof HTMLElement && ownsMapFocus(focused) ? focused : null;
		recoveryFocusTarget =
			ownedFocus && !ownedFocus.closest('[data-map-runtime]') ? ownedFocus : null;
		ownedFocus?.blur();
		recovering = true;
		cameraIntents.state(focusController.pending ? { kind: 'url' } : null);
		onrecovering?.();
	}

	function ownsMapFocus(element: HTMLElement): boolean {
		return Boolean(
			heroEl?.contains(element) || element.closest('[data-map-controls], [data-map-in-view-sheet]'),
		);
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
					ownsMapFocus(focused) &&
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
		vehicleMotion.read(isRecordLayer ? null : mapVehicles, {
			preference: motionMode.current,
			reducedMotion: $prefersReducedMotion,
			ready: hasFirstIdle,
			stale: live.familyStates.vehicles.health.isStale,
			ttlS: manifest.files.live.ttl_s,
			sourceLagS: liveTimingFor(manifest).sourceLagS,
			stops: stopList,
			filter: filters.state,
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
				items: isRecordLayer ? [] : routeLineRoutes,
				selected: selectedRouteLine,
			},
			vehicles: {
				...motionFrame,
				...(isRecordLayer ? { items: [], tickKey: null } : {}),
				filter,
				alertIds: alertVehicleIds,
				selectedId: selectedVehicleId,
			},
			stops: {
				items: isRecordLayer ? [] : stopList,
				filter,
				alertIds: session.alertStopIds,
				selectedId: selectedStopId,
			},
			nearTarget: {
				target: isRecordLayer ? null : nearMeController.origin,
			},
		};
	}

	// Opening/resizing detail surfaces refits only while the camera is fit-owned.
	$effect(() => {
		const instance = map;
		void detailOpen;
		void wide;
		if (!instance) return;
		let disposed = false;
		const update = () => {
			if (disposed) return;
			if (!heroEl) return;
			const inset = measureMapFocusInset(instance);
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
				'.map-head, [data-slot="map-details"], [data-frame-controls], [data-slot="surface-rail-mobile"]',
			))
				observer.observe(el);
			update();
		});
		return () => {
			disposed = true;
			observer.disconnect();
		};
	});
	function wholeNetwork(): void {
		if (!map || !framing) return;
		const inset = measureMapFocusInset(map);
		camera.update(
			map,
			{
				...framing,
				size: { width: inset.containerWidth, height: inset.containerHeight },
				fitPadding: inset.fitPadding,
			},
			true,
		);
	}

	const registerControls = getContext<RegisterFrameControlsExtension | undefined>(
		FrameControlsExtensionContext,
	);
	$effect(() =>
		registerControls?.({
			between: layerChoice,
			extra: mapControls,
			after: desktopLegend,
			hideSummary: () => !wide && remWidth >= 24,
		}),
	);
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
		customAttribution={datedMapNotice ??
			providerAttribution(manifest.provider, manifest.attribution, locale)}
		locale={{
			'Map.Title': t.mapCanvasLabel,
			'AttributionControl.ToggleAttribution': t.attributionToggle,
		}}
		label={t.mapLabel}
	/>
{/snippet}

{#snippet detailPanel()}
	<Card
		edge="neutral"
		class="gap-2 p-3"
		data-slot="map-detail-overlay"
		data-selection-kind={session.selected?.kind}
	>
		<div class="flex items-baseline justify-between gap-2">
			<h2 class="text-lg font-semibold">
				<span class="detail-identity" data-slot="detail-identity" data-kind={selectedDetail?.kind}>
					{#if selectedDetail}
						<span class="detail-identity-kind"
							>{selectedDetail.kind === 'vehicle'
								? selectionCopy.vehicle
								: selectedDetail.kind === 'route'
									? selectionCopy.route
									: selectionCopy.stop}</span
						>
						<span class="detail-identity-title"
							>{selectedDetail.kind === 'vehicle'
								? selectedDetail.vehicle.id
								: selectedDetail.kind === 'route'
									? lineLabel(selectedDetail.id, session.routesIndex)
									: detailStopName(selectedDetail.stop, locale)}</span
						>
					{:else}
						<span class="detail-identity-title">{selectionCopy.alertLink}</span>
					{/if}
				</span>
			</h2>
			<Button
				bind:ref={detailBack}
				variant="ghost"
				size="sm"
				class="min-h-11"
				data-map-detail-back
				aria-label={tr('Clear selection', 'Effacer la sélection')}
				onclick={closeDetail}
			>
				{tr('Clear', 'Effacer')}
			</Button>
		</div>
		{#if selectedDetail}
			<MapSelectionSummary
				detail={selectedDetail}
				{locale}
				{timeZone}
				url={recordUrl}
				city={manifest.provider}
				scheduleOnly={selectedDetail.kind === 'route' &&
					lineIsScheduleOnly(
						page.data.provider,
						selectedDetail.id,
						selectedDetail.route.type ?? null,
					)}
				vehiclesInView={reportView.kind === 'ready' && selectedDetail.kind === 'route'
					? reportView.model.rows.filter((row) => row.routeId === selectedDetail?.id).length
					: null}
				notReporting={selectedVehicleAbsence !== null}
			/>
		{/if}
	</Card>
{/snippet}

{#snippet motionHeader()}
	<MapMotionControl {locale} copy={t} />
{/snippet}

{#snippet mapControls(context: import('@yesid/ui/layout').SurfaceRailContext)}
	{#if !isRecordLayer && !mapFailure}
		<div class="contents" data-map-controls data-ripple-exempt>
			<MapNearMeControl
				bind:open={nearMeController.open}
				bind:query={nearMeController.query}
				{locale}
				copy={t}
				loading={nearMeController.loading}
				error={nearMeController.error}
				origin={nearMeController.origin}
				stops={nearbyStops}
				onuselocation={nearMeController.useLocation}
				onsearch={nearMeController.search}
				onsuggestion={nearMeController.selectSuggestion}
				onstopselect={(stop) => {
					context.closeSheet();
					selectNearbyStop(stop);
				}}
				onclear={nearMeController.clear}
			/>
			<details class="w-full">
				<summary class="min-h-11 py-3 text-sm font-medium"
					>{tr('Map filters', 'Filtres de la carte')}</summary
				>
				<label class="grid gap-1 text-sm">
					{tr('Add a line filter', 'Ajouter une ligne au filtre')}
					<select
						class="min-h-11 min-w-0 rounded-sm border border-border bg-card px-2"
						onchange={(event) => {
							const value = event.currentTarget.value;
							if (value) applyDetailFilter({ kind: 'route', value });
							event.currentTarget.value = '';
						}}
					>
						<option value="">{tr('Choose a line', 'Choisir une ligne')}</option>
						{#each session.routesIndex as route (route.id)}
							<option value={route.id}>{route.short}{route.long ? ` · ${route.long}` : ''}</option>
						{/each}
					</select>
				</label>
				<MapFilters
					{occupancyAvailable}
					store={filters}
					{alertsAvailable}
					{locale}
					routes={session.routesIndex}
					stops={stopList}
					header={motionHeader}
				/>
				<ul class="grid list-none gap-1 p-0 text-sm text-muted-foreground">
					{#each legendDetails.groups.slice(1).flatMap((group) => group.rows) as row (row.id)}
						<li>{row.label}{row.definition ? ` · ${row.definition}` : ''}</li>
					{/each}
				</ul>
				<p class="text-sm text-muted-foreground">{legendDetails.note}</p>
			</details>
		</div>
	{/if}
{/snippet}

{#snippet layerChoice()}
	{#if recordLayer !== 'live'}
		<p class="w-full text-sm font-medium text-muted-foreground">{tr('Layer', 'Couche')}</p>
		<SegmentedChoice
			options={recordOptions}
			value={recordLayer}
			label={tr('Layer', 'Couche')}
			onSelect={changeRecordLayer}
			variant="fit-row"
		/>
		<p class="w-full text-sm text-muted-foreground">
			{recordLayer === 'stops'
				? tr(
						'Stops, by their share of observed stop events that were late.',
						'Arrêts, selon leur part de passages observés en retard.',
					)
				: tr(
						'Stretches between stops, by the time lost.',
						'Tronçons entre arrêts, selon le temps perdu.',
					)}
		</p>
	{/if}
{/snippet}

{#snippet desktopLegend()}
	<MapFrameLegend
		{locale}
		layer={recordLayer}
		{colourBy}
		{railName}
		staleCutoffS={liveTimingFor(manifest).staleCutoffS}
		collapsible
	/>
{/snippet}

{#snippet phoneLegend()}
	<MapFrameLegend
		{locale}
		layer={recordLayer}
		{colourBy}
		{railName}
		staleCutoffS={liveTimingFor(manifest).staleCutoffS}
	/>
{/snippet}

{#snippet stamp()}
	{#if isRecordLayer && recordPeriod}
		<div data-slot="freshness-stamp" data-form="record">
			<time datetime={recordPeriod.to}
				><Stamp kind="record" label={recordStamp(recordPeriod, locale)} /></time
			>
		</div>
	{:else if !isRecordLayer && presentation.stamp.visible}
		<div class="map-stamp-line">
			<div
				data-slot="freshness-stamp"
				data-form="live"
				data-age-seconds={liveTime.ageSeconds ?? undefined}
				data-stale={presentation.stamp.isStale}
			>
				<time datetime={liveTime.generatedUtc ?? undefined}>
					<Stamp kind="live" label={liveStampLabel} late={presentation.stamp.isStale} />
				</time>
			</div>
			<RefreshButton {locale} fixedTapTarget />
		</div>
	{/if}
{/snippet}

{#snippet titleCard(showStamp: boolean)}
	<div class="grid gap-1">
		<h1 class={wide ? 'text-xl font-bold' : 'text-lg font-bold leading-tight'}>{title}</h1>
		{#if wide}<p class="text-sm text-muted-foreground">{city}</p>{/if}
		{#if showStamp}{@render stamp()}{/if}
		{#if !wide && !isRecordLayer}
			<div class:sr-only={remWidth >= 24}><MapFeedStallBanner {presentation} inline /></div>
		{/if}
	</div>
{/snippet}

{#snippet inViewPanel(recordContent: Snippet<[Snippet | undefined]> | undefined)}
	<div class="grid gap-4" bind:this={inViewBody}>
		{#if isRecordLayer}
			{@render recordContent?.(wide ? stamp : undefined)}
		{:else}
			{#if !wide && remWidth >= 24}<MapFeedStallBanner {presentation} inline />{/if}
			<MapInView
				view={reportView}
				{locale}
				line={(id) => lineLabel(id, session.routesIndex)}
				headsign={reportHeadsign}
				onselect={selectReportVehicle}
				stamp={wide ? stamp : undefined}
				detail={detailOpen ? detailPanel : undefined}
				bind:limit={liveListLimit}
				{liveViewHref}
			/>
		{/if}
	</div>
{/snippet}

{#snippet mapRetry()}
	<Button type="button" size="sm" class="min-h-11" onclick={() => void mapFailure?.retry()}>
		{t.mapRetry}
	</Button>
{/snippet}

{#snippet stage()}
	<div class="map-surface" data-slot="map-surface">
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
					action={mapRetry}
				/>
			</div>
		{:else}
			<MapNorthControl copy={t} {...orientation} status={northStatus} onreset={turnNorth} />
			{#if !isRecordLayer}
				{#if wide}<MapFeedStallBanner {presentation} />{/if}
				{#if hoverPeek && wide && !peekRepeatsDetail(hoverPeek, detailOpen ? session.selected : null)}
					<div class="map-peek" data-slot="map-hover-peek">
						<Card edge="neutral" class="p-3"><MapHoverPeek peek={hoverPeek} {locale} /></Card>
					</div>
				{/if}
			{/if}
		{/if}
	</div>
{/snippet}

{#snippet mapContent(recordContent: Snippet<[Snippet | undefined]> | undefined)}
	{#snippet desktopPanel()}
		<div class="map-head">{@render titleCard(false)}</div>
		{@render inViewPanel(recordContent)}
	{/snippet}
	<MapFrame
		label={t.mapLabel}
		class="map-hero-frame absolute inset-x-0 bottom-0"
		style="top: var(--map-frame-top)"
		details={wide ? { label: viewLabel, content: desktopPanel } : undefined}
	>
		{@render stage()}
		{#if !wide}
			<div class="map-mobile-head map-head">
				<Card
					class="gap-1 p-[min(0.75rem,12px)] [--text-small:var(--text-caption)]"
					edge="neutral"
					interactive={!isRecordLayer && presentation.stamp.visible}>{@render titleCard(true)}</Card
				>
			</div>
		{/if}
		<div
			class="map-camera-actions"
			aria-label={tr('Map navigation', 'Navigation de la carte')}
			role="group"
		>
			<Button
				variant="outline"
				size="icon-tap"
				style="width: var(--size-tap-min); height: var(--size-tap-min);"
				aria-label={tr('Zoom in', 'Zoom avant')}
				disabled={!map || recovering}
				onclick={() => {
					camera.interact();
					map?.zoomIn();
				}}>+</Button
			>
			<Button
				variant="outline"
				size="icon-tap"
				style="width: var(--size-tap-min); height: var(--size-tap-min);"
				aria-label={tr('Zoom out', 'Zoom arrière')}
				disabled={!map || recovering}
				onclick={() => {
					camera.interact();
					map?.zoomOut();
				}}>−</Button
			>
			<Button
				variant="outline"
				size={wide ? 'sm' : 'icon-tap'}
				wrap
				class="map-whole-network min-h-[var(--size-tap-min)]"
				style={wide ? undefined : 'width: var(--size-tap-min); height: var(--size-tap-min);'}
				aria-label={tr('Whole network', 'Tout le réseau')}
				disabled={!map || recovering}
				onclick={wholeNetwork}
				>{#if wide}{tr('Whole network', 'Tout le réseau')}{:else}<MaximizeIcon
						aria-hidden="true"
					/>{/if}</Button
			>
		</div>
	</MapFrame>
	{#if !wide}
		<MapLegendControl {locale} hidden={detailOpen || inViewOpen} content={phoneLegend} />
		<Button
			variant="outline"
			size="sm"
			class="map-in-view-button min-h-[var(--size-tap-min)] max-w-full py-[min(0.5rem,8px)]"
			bind:ref={inViewTrigger}
			wrap
			onclick={() => (inViewOpen = true)}
		>
			{inViewCount === null ? viewLabel : `${tr('In view:', 'En vue :')} ${inViewCount}`}
		</Button>
		<Sheet
			open={inViewOpen || detailOpen}
			onOpenChange={(open) => {
				restoreListTrigger = !open && inViewOpen;
				inViewOpen = open;
				if (!open && detailOpen) closeDetail();
			}}
		>
			<SheetContent
				side="bottom"
				closeLabel={tr('Close', 'Fermer')}
				{detents}
				bind:detent={inViewDetent}
				handleLabel={sheetCopy[locale].height}
				class="max-h-dvh overflow-hidden p-4"
				data-slot="bottom-sheet"
				data-m6c2-detail-sheet
				data-map-in-view-sheet
				onEscapeKeydown={(event) => {
					if (inViewOpen && detailOpen) {
						event.preventDefault();
						closeDetail();
					}
				}}
				data-ripple-exempt
				data-lenis-prevent
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					if (restoreListTrigger) inViewTrigger?.focus({ preventScroll: true });
					restoreListTrigger = false;
				}}
			>
				<SheetTitle>{viewLabel}</SheetTitle>
				<div
					data-slot="bottom-sheet-body"
					class="min-h-0 overflow-y-auto"
					use:restoreInViewScroll
					onscroll={(event) => (mobileScrollTop = event.currentTarget.scrollTop)}
				>
					{@render inViewPanel(recordContent)}
				</div>
			</SheetContent>
		</Sheet>
	{/if}
{/snippet}

<svelte:window onkeydown={clearDetailOnEscape} />

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
	data-record-layer={recordLayer}
	data-map-wide={wide}
>
	<span class="map-layout-marker" aria-hidden="true" bind:clientWidth={remWidth}></span>
	<MapRecordPanel
		onsourcedate={(date) => (recordSourceDate = date)}
		oncount={(count) => (recordCount = count)}
		{reportCamera}
		{map}
		layer={recordLayer}
		line={recordLine}
		direction={recordDirection}
		city={manifest.provider}
		period={recordPeriod}
		url={recordUrl}
		{locale}
		stops={stopList}
		routes={session.routesIndex}
		onscope={changeRecordScope}
		children={mapContent}
	/>
</div>

<style>
	.detail-identity {
		display: grid;
		gap: 0.125rem;
		min-width: 0;
	}
	.detail-identity-kind {
		font-family: var(--font-mono);
		font-size: var(--text-micro);
		font-weight: 500;
		line-height: 1.2;
		letter-spacing: var(--tracking-eyebrow);
		text-transform: uppercase;
		color: var(--muted-foreground);
	}
	.detail-identity-title {
		min-width: 0;
		overflow-wrap: anywhere;
		font-family: var(--font-heading);
		font-size: var(--text-card-title);
		font-weight: 700;
		line-height: 1.15;
		letter-spacing: -0.01em;
		color: var(--foreground);
	}
	.detail-identity[data-kind='vehicle'] .detail-identity-title,
	.detail-identity[data-kind='route'] .detail-identity-title {
		font-variant-numeric: tabular-nums;
	}

	.map-hero {
		position: relative;
		width: 100%;
		height: 100%;
		background: var(--background);
		--map-frame-top: var(--chrome-offset);
		--map-mobile-control-bottom: calc(var(--map-touch-row-bottom) + var(--size-tap-min) + 0.5rem);
		--map-north-clearance: calc(var(--map-mobile-control-bottom) + 10.25rem);
		--map-controls-width: 0px;
		--z-map-canvas: 1;
		--z-map-overlay: 2;
		--z-map-banner-content: 2;
		--z-map-detail: 3;
	}
	.map-hero[data-map-wide='false'] {
		--map-attribution-bottom: calc(
			var(--map-touch-row-bottom) + max(2.75rem, var(--size-tap-min)) + 0.75rem
		);
	}
	.map-surface {
		position: absolute;
		inset: calc(0px - var(--map-frame-top)) 0 0;
		overflow: hidden;
	}
	.map-hero[data-record-layer]:not([data-record-layer='live'])
		:global([data-slot='vehicle-overlay']) {
		visibility: hidden;
	}
	.map-layout-marker {
		position: absolute;
		display: block;
		width: 1rem;
		height: 0;
	}
	.map-mobile-head {
		position: absolute;
		inset: 0.75rem 0.75rem auto;
		width: fit-content;
		max-width: calc(100% - var(--size-tap-min) - 2rem);
		z-index: 1;
	}
	:global(.map-hero-frame [data-slot='map-stage']) {
		min-block-size: 0;
	}
	.map-stamp-line {
		display: flex;
		align-items: center;
		gap: var(--spacing);
		min-width: 0;
		font-variant-numeric: tabular-nums;
	}
	:global(.map-in-view-button) {
		position: absolute;
		inset-block-end: var(--map-touch-row-bottom);
		inset-inline-end: 0.75rem;
		background: var(--card);
		z-index: 2;
	}
	.map-camera-actions {
		position: absolute;
		inset-block-start: 0.75rem;
		inset-inline-end: 0.75rem;
		display: grid;
		justify-items: end;
		gap: 0.5rem;
		z-index: 1;
	}
	.map-camera-actions :global(.button) {
		background: var(--card);
	}
	@media (orientation: landscape) and (max-height: 32rem) {
		.map-hero[data-map-wide='false'] .map-camera-actions {
			grid-auto-flow: column;
		}
		.map-hero[data-map-wide='false'] :global([data-slot='map-north']) {
			top: calc(var(--map-frame-top) + 0.75rem);
			right: calc(0.75rem + 3 * (var(--size-tap-min) + 0.5rem));
			bottom: auto;
		}
		.map-hero[data-map-wide='false'] .map-mobile-head {
			max-width: calc(100% - 4 * var(--size-tap-min) - 3.5rem);
		}
	}
	.map-peek {
		position: absolute;
		z-index: var(--z-map-detail);
		inset-inline-end: calc(min(20rem, 31%) + 1.5rem);
		inset-block-end: var(--map-north-clearance);
		max-width: min(20rem, 38%);
		pointer-events: none;
	}
	.map-stage-error {
		position: absolute;
		z-index: var(--z-map-detail);
		inset: 0;
		display: grid;
		place-items: center;
	}
	.map-hero[data-map-wide='true'] .map-camera-actions {
		inset-block-start: auto;
		inset-inline-end: calc(min(20rem, 31%) + 1.5rem);
		inset-block-end: calc(var(--map-source-clearance, 0px) + 0.75rem);
	}
	.map-hero[data-map-wide='true'] {
		--map-frame-top: calc(var(--chrome-offset) - 0.75rem);
		--map-detail-offset: min(20rem, 31%);
	}
</style>
