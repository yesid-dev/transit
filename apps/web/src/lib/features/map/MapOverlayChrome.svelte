<script lang="ts">
	import type { LivePresentation } from '#lib/v1/live/livePresentation.ts';
	import type { Snippet } from 'svelte';
	import type { Locale } from '#lib/i18n/index.ts';
	import type { FilterStore } from '#lib/filters/index.ts';
	import type { LatLon, WithDistance } from '#lib/components/map/index.ts';
	import { colourDimension } from '#lib/components/map/vehicleLayer.ts';
	import type { GeocodePrecision, GeocodeSuggestion } from '#lib/geocode/types.ts';
	import type { StopIndexEntry } from '#lib/v1/schemas/index.ts';
	import type { MapCopy } from './map.copy';
	import { peekRepeatsDetail, type MapHoverPeek as MapHoverPeekModel } from './mapHoverPeek';
	import type { MapSelection } from './selectionSession/mapSelection';
	import MapHeadTitle from './MapHeadTitle.svelte';
	import MapNearMeControl from './MapNearMeControl.svelte';
	import MapNorthControl from './MapNorthControl.svelte';
	import MapFilterPill from './MapFilterPill.svelte';
	import MapLegendControl from './MapLegendControl.svelte';
	import MapFreshness from './MapFreshness.svelte';
	import MapFeedStallBanner from './MapFeedStallBanner.svelte';
	import MapHoverPeek from './MapHoverPeek.svelte';

	type NearMeOrigin = LatLon & { label: string; precision?: GeocodePrecision };

	interface Props {
		orientation: { bearing: number; pitch: number };
		northStatus: string;
		onnorth: () => void;
		locale: Locale;
		t: MapCopy;
		presentation: LivePresentation;
		nearMeOpen: boolean;
		nearMeQuery: string;
		nearMeLoading: boolean;
		nearMeError: string | null;
		nearMeOrigin: NearMeOrigin | null;
		nearbyStops: readonly WithDistance<StopIndexEntry>[];
		onuselocation: () => void;
		onsearch: (event: SubmitEvent) => void | Promise<void>;
		onsuggestion: (result: GeocodeSuggestion) => void | Promise<void>;
		onstopselect: (stop: WithDistance<StopIndexEntry>) => void;
		onclear: () => void;
		isDesktop: boolean;
		filtersStore: FilterStore;
		/** The live map's cutoff for a vehicle with no recent position, in seconds. */
		staleCutoffS: number;
		detailOpen: boolean;
		hoverPeek: MapHoverPeekModel | null;
		/** The selection the expanded detail panel is showing, if any. */
		detailSelection?: MapSelection | null;
		viewMode: 'map' | 'reports';
		onviewchange: (next: 'map' | 'reports') => void;
		controls: Snippet<[{ collapsible?: boolean } | undefined]>;
		layers?: Snippet;
		record?: boolean;
	}

	let {
		orientation,
		northStatus,
		onnorth,
		locale,
		t,
		presentation,
		nearMeOpen = $bindable(),
		nearMeQuery = $bindable(),
		nearMeLoading,
		nearMeError,
		nearMeOrigin,
		nearbyStops,
		onuselocation,
		onsearch,
		onsuggestion,
		onstopselect,
		onclear,
		isDesktop,
		filtersStore,
		staleCutoffS,
		detailOpen,
		hoverPeek,
		detailSelection = null,
		viewMode,
		onviewchange,
		controls,
		layers,
		record = false,
	}: Props = $props();
	const colourBy = $derived(colourDimension(filtersStore.state));
	// Hovering what the open panel already shows would only repeat it over the map.
	const visiblePeek = $derived(peekRepeatsDetail(hoverPeek, detailSelection) ? null : hoverPeek);

	let desktopControlsMounted = $state(false);
	let headHeight = $state(0);
	let layersHeight = $state(0);
	let panelHeight = $state(0);
	let controlsOpen = $state(false);
	let legendOpen = $state(false);
	$effect(() => {
		if (isDesktop) desktopControlsMounted = true;
	});
</script>

<div
	data-slot="map-freshness-owner"
	data-active-placement={isDesktop ? 'floating' : 'head'}
	data-not-responding={presentation.stamp.ageLabel ? 'true' : 'false'}
>
	<MapHeadTitle
		{locale}
		heading={t.heading}
		lead={t.headingLead}
		presentation={presentation.stamp}
		{viewMode}
		onviewchange={record ? undefined : onviewchange}
		{record}
		bind:height={headHeight}
	/>
	{#if !record}<MapFreshness placement="floating" presentation={presentation.stamp} {locale} />{/if}
</div>

<MapNorthControl copy={t} {...orientation} status={northStatus} onreset={onnorth} />

{#if !record}
	<MapNearMeControl
		bind:open={nearMeOpen}
		bind:query={nearMeQuery}
		{locale}
		copy={t}
		loading={nearMeLoading}
		error={nearMeError}
		origin={nearMeOrigin}
		stops={nearbyStops}
		{onuselocation}
		{onsearch}
		{onsuggestion}
		{onstopselect}
		{onclear}
	/>
{/if}

{#if layers}
	<div
		class="map-layer-controls"
		class:record
		style:--map-head-height="{headHeight}px"
		bind:offsetHeight={layersHeight}
	>
		{@render layers()}
	</div>
{/if}

{#if !record}
	{#if isDesktop || desktopControlsMounted}
		<div
			class="map-overlay map-controls-column"
			style:--map-head-height="{headHeight}px"
			style:--map-layers-clearance="{layersHeight ? layersHeight + 8 : 0}px"
			style:--map-panel-height="{panelHeight}px"
		>
			<div class="map-filter-panel" bind:clientHeight={panelHeight}>
				{@render controls(undefined)}
			</div>
			<MapLegendControl {locale} presentation="desktop" {colourBy} {staleCutoffS} />
		</div>
	{/if}

	<MapFilterPill
		store={filtersStore}
		{locale}
		hidden={detailOpen}
		{controls}
		bind:open={controlsOpen}
		onopenchange={(open) => {
			if (open) legendOpen = false;
		}}
	/>
	<MapLegendControl
		{locale}
		presentation="phone"
		{colourBy}
		{staleCutoffS}
		hidden={detailOpen}
		bind:open={legendOpen}
		onopenchange={(open) => {
			if (open) controlsOpen = false;
		}}
	/>

	<MapFeedStallBanner {presentation} />

	{#if visiblePeek && isDesktop && !nearMeOpen}
		<div class="map-overlay map-peek" data-slot="map-hover-peek">
			<MapHoverPeek peek={visiblePeek} {locale} />
		</div>
	{/if}
{/if}

<style>
	.map-overlay {
		position: absolute;
		z-index: var(--z-map-overlay);
	}
	.map-layer-controls {
		position: absolute;
		z-index: var(--z-map-overlay);
		top: calc(var(--chrome-offset) + var(--map-head-height) + 0.5rem);
		left: calc(var(--app-left-rail-offset, 0rem) + 1rem);
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.5rem;
		max-width: calc(
			100% - var(--app-left-rail-offset, 0rem) - var(--map-detail-offset, 0rem) - 2rem
		);
		pointer-events: none;
	}
	.map-layer-controls > :global(*) {
		pointer-events: auto;
	}
	.map-controls-column {
		--legend-reserve: min(18rem, 32dvh);
		--column-top: calc(
			var(--chrome-offset) +
				max(4rem, var(--map-head-height, 0px) + var(--map-layers-clearance, 0px) + 0.75rem)
		);
		--column-room: calc(100dvh - var(--announcement-height, 0px) - var(--column-top) - 3rem);
		--map-legend-body-room: max(
			0px,
			calc(var(--column-room) - var(--map-panel-height) - var(--size-tap-min) - var(--spacing) * 4)
		);
		display: flex;
		flex-direction: column;
		gap: calc(var(--spacing) * 3);
		width: 300px;
		max-height: var(--column-room);
		top: var(--column-top);
		left: calc(var(--app-left-rail-offset, 0rem) + 1rem);
	}

	.map-filter-panel {
		min-height: 0;
		flex: none;
	}
	.map-controls-column:has(:global(.map-legend-header[aria-expanded='false'])) {
		--legend-reserve: var(--size-tap-min);
	}
	.map-controls-column :global(.map-filters) {
		max-height: calc(var(--column-room) - var(--legend-reserve) - var(--spacing) * 4);
	}

	.map-peek {
		right: calc(var(--map-detail-offset, 0rem) + 1rem);
		bottom: var(--map-near-clearance, 8.6rem);
		z-index: var(--z-map-detail);
		max-width: min(
			20rem,
			calc(100% - var(--map-detail-offset, 0rem) - var(--app-left-rail-offset, 0rem) - 18rem)
		);
		padding: 0.75rem 0.875rem;
		background: color-mix(in srgb, var(--card) 92%, transparent);
		border: 1px solid var(--border-hairline);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-card);
		-webkit-backdrop-filter: blur(var(--glass-blur-sm));
		backdrop-filter: blur(var(--glass-blur-sm));
		pointer-events: none;
	}
	.map-peek :global(.map-hover-peek) {
		min-width: 0;
	}
	@media (prefers-reduced-motion: reduce) {
		:global(.mf-chip) {
			transition: none;
		}
	}

	@media (--desktop-max) {
		.map-layer-controls {
			right: 0.75rem;
			left: auto;
			align-items: flex-end;
			max-width: calc(100% - 1.5rem);
		}
		.map-controls-column {
			display: none;
		}
		.map-peek {
			display: none;
		}
	}

	@media (--desktop-max) and (orientation: landscape) {
		.map-layer-controls:not(.record) {
			top: var(--chrome-offset);
			right: auto;
			left: 0.75rem;
			align-items: flex-start;
			max-width: calc(35% - 0.75rem);
		}
	}
</style>
