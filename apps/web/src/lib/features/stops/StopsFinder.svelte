<script lang="ts">
	import { onDestroy } from 'svelte';
	import { page } from '$app/state';
	import { invalidateAll } from '$app/navigation';
	import type { RouteIndexEntry } from '#lib/v1/schemas/routes_index.ts';
	import type { StopIndexEntry } from '#lib/v1/schemas/stops_index.ts';
	import { intl, getLocale, getLocalizeHref } from '#lib/i18n/index.ts';
	import { currentMirrorUrl, mirrorSearchParams } from '#lib/site/urlMirror.ts';
	import { foldSearchText } from '#lib/search/normalize.ts';
	import { routeModeHint } from '#lib/search/stopMode.ts';
	import type { LatLon } from '#lib/components/map/nearbyStops.ts';
	import { desktop } from '@yesid/ui/state';
	import { ListingFrame } from '@yesid/ui/layout';
	import { FilterSection, SearchInput } from '@yesid/ui/brand';
	import { StateNotice } from '@yesid/ui/feedback';
	import { Combobox, type ComboboxOption } from '@yesid/ui/combobox';
	import { EdgeState } from '#lib/components/edge/index.ts';
	import {
		FINDER_PAGE_SIZE,
		finderSearchParams,
		lineRows,
		nearRows,
		networkRows,
		nextPageSize,
		parseFinderState,
		providerHref,
		stopHasNoLiveData,
		type FinderRow,
		type FinderState,
	} from './finderState';
	import { indexCopy } from './stops.copy';
	import type { StopsRecord } from '#lib/server/finderRecord.ts';
	import { dateRange } from '#lib/site/presenter.ts';
	import StopFinderTable from './StopFinderTable.svelte';

	import type { ScheduleEdition } from '#lib/search/searchIndex.ts';
	import type { PublicCity } from '#lib/v1/schemas/providers.ts';

	let {
		record = null,
		schedule = null,
		provider = null,
	}: {
		record?: StopsRecord | null;
		schedule?: ScheduleEdition | null;
		provider?: PublicCity | null;
	} = $props();
	const locale = getLocale();
	const t = $derived(indexCopy[locale]);
	const localizeHref = getLocalizeHref();
	const providerId = $derived(record?.city ?? provider?.id ?? '');
	const providerName = $derived(provider?.labels[locale].operator ?? providerId);

	let view = $state<FinderState>(parseFinderState(new URLSearchParams(page.url.search)));
	$effect(() => {
		mirrorSearchParams(finderSearchParams(view));
	});

	function apply(patch: Partial<FinderState>): void {
		view = { ...view, ...patch };
	}
	/** Any narrowing resets the list to its first page, as the count then changes. */
	function narrow(patch: Partial<FinderState>): void {
		view = { ...view, ...patch, shown: FINDER_PAGE_SIZE };
	}

	const collator = intl.collator(locale, { numeric: true, sensitivity: 'base' });
	const numberFmt = intl.number(locale);
	const allStops = $derived(schedule?.stops ?? []);
	const routes = $derived<readonly RouteIndexEntry[]>(schedule?.routes ?? []);
	const routeById = $derived(new Map(routes.map((route) => [route.id, route])));
	const selectedLine = $derived(view.route ? (routeById.get(view.route) ?? null) : null);
	const lineOptions = $derived<ComboboxOption[]>(
		[...routes]
			.sort((a, b) => collator.compare(a.short, b.short))
			.map((route) => ({
				value: route.id,
				label: route.short,
				sublabel: route.long ?? undefined,
				glyph: routeModeHint(route.type).glyph,
				search: foldSearchText([route.id, route.short, route.long].filter(Boolean).join(' ')),
			})),
	);

	// "Stops near me" is asked for only on action and stays on this page: the reader's position is
	// never written to the URL, so a copied link cannot carry it.
	type NearStatus =
		| 'idle'
		| 'asking'
		| 'active'
		| 'denied'
		| 'timeout'
		| 'unavailable'
		| 'insecure';
	let nearStatus = $state<NearStatus>('idle');
	let nearOrigin = $state.raw<LatLon | null>(null);
	const nearActive = $derived(nearStatus === 'active' && nearOrigin != null);
	let alive = true;
	onDestroy(() => {
		alive = false;
	});

	function stopNear(): void {
		nearStatus = 'idle';
		nearOrigin = null;
	}

	function askNear(): void {
		if (!window.isSecureContext) {
			nearStatus = 'insecure';
			return;
		}
		const geolocation = navigator.geolocation;
		if (!geolocation) {
			nearStatus = 'unavailable';
			return;
		}
		nearStatus = 'asking';
		geolocation.getCurrentPosition(
			(position) => {
				if (!alive || nearStatus !== 'asking') return;
				nearOrigin = { lat: position.coords.latitude, lon: position.coords.longitude };
				nearStatus = 'active';
				narrow({ route: null, order: 'default', stop: null });
			},
			(error) => {
				if (!alive || nearStatus !== 'asking') return;
				nearStatus =
					error.code === error.PERMISSION_DENIED
						? 'denied'
						: error.code === error.TIMEOUT
							? 'timeout'
							: 'unavailable';
			},
			{ enableHighAccuracy: true, timeout: 8_000, maximumAge: 60_000 },
		);
	}

	const nearMessage = $derived(
		{
			idle: null,
			asking: t.nearAsking,
			active: t.nearActive,
			denied: t.nearDenied,
			timeout: t.nearTimeout,
			unavailable: t.nearUnavailable,
			insecure: t.nearInsecure,
		}[nearStatus],
	);

	function chooseLine(id: string | null): void {
		stopNear();
		narrow({ route: id ?? null, stop: null });
	}

	function clearFilters(): void {
		stopNear();
		narrow({ query: '', route: null, order: 'default', stop: null });
	}

	const rows = $derived.by<FinderRow[]>(() => {
		if (nearActive && nearOrigin) return nearRows(nearOrigin, allStops, view.query);
		const directions = view.route ? schedule?.route_directions?.[view.route] : null;
		if (directions) return lineRows({ directions }, allStops, view.query);
		const route = view.route;
		const stops = route ? allStops.filter((stop) => stop.routes?.includes(route)) : allStops;
		return networkRows(stops, view.query, collator.compare);
	});
	const shownRows = $derived(rows.slice(0, view.shown));
	const moreCount = $derived(nextPageSize(view.shown, rows.length));

	const countText = $derived.by(() => {
		const shown = numberFmt.format(shownRows.length);
		const matching = numberFmt.format(rows.length);
		if (nearActive) return t.nearCounts(shown, matching);
		if (view.route) return t.lineCounts(shown, matching, selectedLine?.short ?? view.route);
		return t.counts(shown, matching, numberFmt.format(allStops.length));
	});

	const noMatch = $derived(rows.length === 0);
	// Nearby with a typed filter that matches nothing is a no-match, never a claim about distance.
	const noMatchTitle = $derived(
		nearActive && !view.query
			? t.nearNone
			: view.route && !view.query
				? t.noLineStops
				: view.query
					? t.noMatch(view.query)
					: t.noMatchFilters,
	);
	const addressHref = $derived(
		providerHref({ base: currentMirrorUrl(), path: localizeHref('/search', locale), providerId }),
	);
	const resultsUrl = $derived.by(() => {
		const url = new URL(page.url.href);
		for (const [key, value] of Object.entries(finderSearchParams(view))) {
			if (value == null) url.searchParams.delete(key);
			else url.searchParams.set(key, value);
		}
		return url;
	});

	/** Unknown line types make no claim: only declared lines without live data count. */
	function noLiveData(stop: StopIndexEntry): boolean {
		return stopHasNoLiveData(
			stop,
			(line) =>
				provider?.lines_without_live_data.some(
					(gap) =>
						gap.route_ids.includes(line) ||
						gap.route_types.some((type) => type === routeById.get(line)?.type),
				) ?? false,
		);
	}

	function lineShorts(stop: StopIndexEntry): string[] {
		return (stop.routes ?? []).map((id) => routeById.get(id)?.short ?? id);
	}

	function metaText(row: FinderRow): string {
		const lines = lineShorts(row.stop);
		return [
			row.stop.code ? t.row.code(row.stop.code) : null,
			lines.length > 0 ? t.row.lines(lines.length, lines.join(', ')) : null,
			row.towards ? t.row.towards(row.towards) : null,
			row.distanceM == null
				? null
				: t.row.distance(numberFmt.format(Math.round(row.distanceM / 10) * 10)),
		]
			.filter(Boolean)
			.join(' · ');
	}
</script>

{#snippet listingSearch()}
	<SearchInput
		label={t.filterLabel}
		placeholder={t.searchPlaceholder}
		testId="stops-filter-input"
		value={view.query}
		oninput={(event) =>
			narrow({ query: (event.currentTarget as HTMLInputElement).value, stop: null })}
	/>
{/snippet}

{#snippet listingFilters()}
	<FilterSection>
		<div class="finder-line-filter">
			<span class="label-section text-sm font-semibold">{t.lineLabel}</span>
			<Combobox
				options={lineOptions}
				bind:value={() => view.route, chooseLine}
				label={t.lineLabel}
				placeholder={t.linePlaceholder}
				clearLabel={t.lineClear}
				emptyLabel={t.lineEmpty}
				fold={foldSearchText}
			/>
		</div>
	</FilterSection>
{/snippet}

<ListingFrame
	presentation="reading"
	rule="dimension"
	heading={t.heading}
	subtitle={providerName}
	description={record ? dateRange(record.period, locale) : t.lede}
	filterLabel={t.controlsLabel}
	resultCountText={schedule ? countText : undefined}
	search={listingSearch}
	filters={listingFilters}
>
	<nav class="finder-ways" aria-label={t.nearLabel} data-slot="stops-nearby">
		{#if nearActive}
			<button type="button" class="finder-way tap-press" onclick={stopNear}>{t.nearClear}</button>
		{:else}
			<button
				type="button"
				class="finder-way tap-press"
				aria-busy={nearStatus === 'asking'}
				disabled={nearStatus === 'asking'}
				onclick={askNear}
			>
				{t.nearMe}
			</button>
		{/if}
		<a class="finder-way" href={addressHref}>{t.nearAddress}</a>
	</nav>
	<p class="finder-near-status" role="status" aria-live="polite" data-slot="stops-near-status">
		{nearMessage ?? ''}
	</p>

	{#if !schedule}
		<EdgeState
			variant="error-v1"
			lang={locale}
			layout={desktop.current ? 'desktop' : 'mobile'}
			onRetry={() => void invalidateAll()}
		/>
	{:else if !record}
		<StateNotice
			title={locale === 'fr' ? 'Période indisponible' : 'Period unavailable'}
			presentation="silo"
			role="status"
		/>
	{:else}
		<div class="finder finder-record" data-slot="stops-finder">
			<div class="finder-results" role="region" aria-label={t.listLabel}>
				<p class="finder-count" data-slot="finder-counts">{countText}</p>
				{#if noMatch}
					<StateNotice title={noMatchTitle} presentation="frameless" role="status">
						{#snippet action()}
							<button type="button" class="finder-button tap-press" onclick={clearFilters}>
								{t.clearFilters}
							</button>
						{/snippet}
					</StateNotice>
				{:else}
					<StopFinderTable
						{record}
						{locale}
						url={resultsUrl}
						stops={shownRows}
						stopMeta={metaText}
						{noLiveData}
					/>
					{#if moreCount > 0}
						<button
							type="button"
							class="finder-button tap-press"
							onclick={() => apply({ shown: view.shown + FINDER_PAGE_SIZE })}
						>
							{moreCount === 1 ? t.showMoreLast : t.showMore(numberFmt.format(moreCount))}
						</button>
					{/if}
				{/if}
			</div>
		</div>
	{/if}
</ListingFrame>

<style>
	.finder-results {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-width: 0;
		scroll-margin-block-start: 1rem;
	}

	.finder-results:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 4px;
	}

	.finder-ways {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		min-width: 0;
	}

	.finder-way {
		display: inline-flex;
		min-height: var(--size-tap-min);
		align-items: center;
		padding: 0.375rem 0.875rem;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-pill);
		background: transparent;
		color: var(--foreground);
		font: inherit;
		font-size: var(--text-small);
		text-decoration: none;
		cursor: pointer;
	}

	.finder-way:hover,
	.finder-way:focus-visible {
		border-color: var(--primary);
		color: var(--primary);
	}

	.finder-way:disabled {
		cursor: progress;
		opacity: 0.7;
	}

	.finder-near-status:empty {
		display: none;
	}

	.finder-count,
	.finder-near-status {
		margin: 0;
		font-size: var(--text-small);
		line-height: 1.45;
		color: var(--muted-foreground);
		overflow-wrap: break-word;
	}

	.finder-count {
		font-variant-numeric: tabular-nums;
	}

	.finder-line-filter {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 0;
	}

	.finder-line-filter :global([data-slot='combobox']) {
		width: 100%;
	}

	.finder-button {
		display: inline-flex;
		min-height: var(--size-tap-min);
		align-items: center;
		justify-content: center;
		padding: 0.5rem 0.875rem;
		border: 1px solid var(--border-brand);
		border-radius: var(--radius-pill);
		background: var(--surface-1);
		color: var(--foreground);
		font: inherit;
		font-size: var(--text-control);
		font-weight: 600;
		cursor: pointer;
	}

	.finder-button:hover,
	.finder-button:focus-visible {
		border-color: var(--primary);
		color: var(--primary);
	}
</style>
