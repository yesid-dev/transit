<script lang="ts">
	import { onDestroy, onMount, tick, untrack } from 'svelte';
	import { page } from '$app/state';
	import { getV1Runtime } from '#lib/v1/runtime.ts';
	import { getV1Context } from '#lib/v1/boot.ts';
	import { getPublishedReliabilityIndex } from '#lib/v1/repositories/historic.ts';
	import { getRoute, getRoutesIndex, getStopsIndex } from '#lib/v1/repositories/static.ts';
	import { createResource } from '#lib/v1/resource.svelte.ts';
	import { createPublishedWeeklyRanking } from '#lib/v1/ranking/published.ts';
	import type { RouteIndexEntry } from '#lib/v1/schemas/routes_index.ts';
	import type { StopIndexEntry } from '#lib/v1/schemas/stops_index.ts';
	import { intl, getLocale, getLocalizeHref } from '#lib/i18n/index.ts';
	import { mapHrefFor, routeFor } from '#lib/nav/index.ts';
	import { stopDisplayName } from '#lib/site/transitDisplay.ts';
	import { currentMirrorUrl, mirrorSearchParams } from '#lib/site/urlMirror.ts';
	import { foldSearchText } from '#lib/search/normalize.ts';
	import { routeModeHint, stopModeTag } from '#lib/search/stopMode.ts';
	import type { LatLon } from '#lib/components/map/nearbyStops.ts';
	import { desktop } from '@yesid/ui/state';
	import { ListingFrame } from '@yesid/ui/layout';
	import { FilterGroup, FilterSection, SearchInput } from '@yesid/ui/brand';
	import { Card } from '@yesid/ui/card';
	import { StateNotice } from '@yesid/ui/feedback';
	import { Combobox, type ComboboxOption } from '@yesid/ui/combobox';
	import { EntityList, EntityResultRow, ResourceBoundary } from '#lib/components/surface/index.ts';
	import { createGaugeHold, gaugeFiller } from '#lib/components/surface/gaugeHold.svelte.ts';
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
		publishedOrderRows,
		stopHasNoLiveData,
		stopRecordHref,
		type FinderRow,
		type FinderState,
	} from './finderState';
	import { routeHasNoLiveData } from '#lib/v1/providers.ts';
	import { periodRange, presentStopRecord, type StopRecordView } from './stopRecord';
	import StopsFinderPreview from './StopsFinderPreview.svelte';
	import { detailCopy, indexCopy } from './stops.copy';
	import type { StopsRecord } from '#lib/server/finderRecord.ts';
	import { dateRange } from '#lib/features/record/recordText.ts';
	import StopFinderTable from './StopFinderTable.svelte';

	let { record = null }: { record?: StopsRecord | null } = $props();
	const locale = getLocale();
	const t = $derived(indexCopy[locale]);
	// The stop page's own Live now words, so a row and its page say the same about live data.
	const noLiveDataText = $derived(detailCopy[locale].live.noCapability);
	const localizeHref = getLocalizeHref();
	const runtime = getV1Runtime();
	const v1 = getV1Context();
	const providerId = $derived(v1.manifest.provider);
	// The stop record's own operator name, so a row's citation and CSV match the stop page's.
	const shortName = $derived(v1.manifest.short_name?.trim() || v1.manifest.display_name);
	const providerName = $derived(v1.provider?.labels[locale]?.operator ?? shortName);

	onMount(() => runtime.clock.subscribe());

	const published = createResource(
		(signal) => (record ? Promise.resolve(null) : getPublishedReliabilityIndex({ signal })),
		{ key: () => Boolean(record) },
	);
	const index = createResource(() => getStopsIndex());
	const routesIndex = createResource(() => getRoutesIndex());

	/**
	 * While the list first loads, a gauge list lays out invisibly under the skeleton: a full first
	 * page of rows with long names and several lines, so the list's room is taken from the first
	 * render. When the stops arrive, the region keeps that height until the reader acts or the
	 * width changes, so the footer below never moves.
	 */
	const hold = createGaugeHold(() => !(index.settled && routesIndex.settled));
	const GAUGE_NAME = gaugeFiller(
		'Henri-Bourassa / Lajeunesse (Terminus Henri-Bourassa, quai Nord)',
	);
	const gaugeRows: FinderRow[] = Array.from({ length: FINDER_PAGE_SIZE }, (_, n) => ({
		key: `gauge-${n}`,
		stop: {
			id: `gauge-${n}`,
			name: GAUGE_NAME,
			code: '00000',
			lat: 0,
			lon: 0,
			mode: 'bus',
			routes: ['000', '000', '000'],
		},
		towards: null,
		distanceM: null,
	}));
	const gaugeCount = $derived(gaugeFiller(t.counts('00', '0,000', '0,000')));

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

	const lineRoute = createResource(
		() => {
			const id = view.route;
			return id ? getRoute(id) : Promise.resolve(null);
		},
		{ key: () => view.route },
	);

	const collator = intl.collator(locale, { numeric: true, sensitivity: 'base' });
	const numberFmt = intl.number(locale);
	const allStops = $derived<readonly StopIndexEntry[]>(index.data?.stops ?? []);
	const routes = $derived<readonly RouteIndexEntry[]>(routesIndex.data?.routes ?? []);
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

	const weekly = $derived(
		createPublishedWeeklyRanking(published.data)('stop', runtime.clock.serverNow),
	);
	const rankedIds = $derived(
		weekly?.filter((row) => row.state === 'ranked').map((row) => row.id) ?? [],
	);
	const lateAvailable = $derived(rankedIds.length > 0);
	const lateActive = $derived(view.order === 'late' && lateAvailable && !nearActive);
	const rankedWeek = $derived.by(() => {
		const first = weekly?.find((row) => row.state === 'ranked');
		return first ? periodRange(first.window_start, first.window_end, locale) : null;
	});

	const baseRows = $derived.by<FinderRow[]>(() => {
		if (nearActive && nearOrigin) return nearRows(nearOrigin, allStops, view.query);
		if (view.route) return lineRows(lineRoute.data, allStops, view.query);
		return networkRows(allStops, view.query, collator.compare);
	});
	const rows = $derived(lateActive ? publishedOrderRows(baseRows, rankedIds) : baseRows);
	const shownRows = $derived(rows.slice(0, view.shown));
	const moreCount = $derived(nextPageSize(view.shown, rows.length));
	const lineLoading = $derived(!nearActive && view.route != null && !lineRoute.settled);

	const countText = $derived.by(() => {
		const shown = numberFmt.format(shownRows.length);
		const matching = numberFmt.format(rows.length);
		if (nearActive) return t.nearCounts(shown, matching);
		if (view.route) return t.lineCounts(shown, matching, selectedLine?.short ?? view.route);
		return t.counts(shown, matching, numberFmt.format(allStops.length));
	});

	const noMatch = $derived(index.settled && !lineLoading && rows.length === 0);
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
	const rangeRequested = $derived(
		page.url.searchParams.has('from') || page.url.searchParams.has('to'),
	);
	const defaultOrderLabel = $derived(
		view.route ? t.orderLine : view.query ? t.orderMatch : t.orderName,
	);

	function recordUrl(stop: StopIndexEntry): string {
		return new URL(localizeHref(routeFor({ kind: 'stop', id: stop.id }), locale), page.url.origin)
			.href;
	}

	/** The stop page's own record answer for this stop, from the same published weekly file. */
	function recordFor(stop: StopIndexEntry): StopRecordView {
		return presentStopRecord(
			{ stopId: stop.id, index: published, now: runtime.clock.serverNow },
			locale,
			{
				operator: shortName,
				stopId: stop.id,
				stopCode: stop.code ?? null,
				stopName: stopDisplayName(stop.name),
				url: recordUrl(stop),
			},
		);
	}

	function recordHref(stop: StopIndexEntry, record: StopRecordView): string {
		return stopRecordHref({
			base: currentMirrorUrl(),
			path: localizeHref(routeFor({ kind: 'stop', id: stop.id }), locale),
			providerId,
			window: record.window,
		});
	}

	function mapHref(stop: StopIndexEntry): string {
		return providerHref({
			base: currentMirrorUrl(),
			path: mapHrefFor({ stop: stop.id }, locale),
			providerId,
		});
	}

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
		return stopHasNoLiveData(stop, (line) =>
			routeHasNoLiveData(providerId, routeById.get(line)?.type),
		);
	}

	function lineShorts(stop: StopIndexEntry): string[] {
		return (stop.routes ?? []).map((id) => routeById.get(id)?.short ?? id);
	}

	function metaText(row: FinderRow): string {
		const lines = lineShorts(row.stop);
		return [
			row.stop.code ? t.row.code(row.stop.code) : null,
			record ? null : stopModeTag(row.stop),
			lines.length > 0 ? t.row.lines(lines.length, lines.join(', ')) : null,
			row.towards ? t.row.towards(row.towards) : null,
			row.distanceM == null
				? null
				: t.row.distance(numberFmt.format(Math.round(row.distanceM / 10) * 10)),
		]
			.filter(Boolean)
			.join(' · ');
	}

	const ROW_STATE = {
		failed: 'failed',
		unpublished: 'unpublished',
		'not-current': 'notCurrent',
		'not-listed': 'notListed',
	} as const;

	/** The row's record line: the week and its readings, or in words why there is no share. */
	function detailText(record: StopRecordView): string {
		if (record.state === 'pending') return '';
		if (record.share) {
			const range = periodRange(record.share.windowStart, record.share.windowEnd, locale);
			const week = range.charAt(0).toUpperCase() + range.slice(1);
			return `${week} · ${t.row.basis(numberFmt.format(record.share.readings))}`;
		}
		if (record.unmeasured) return t.row.state[record.unmeasured];
		return record.state === 'unmeasured' || record.state === 'measured'
			? (record.status ?? '')
			: t.row.state[ROW_STATE[record.state]];
	}

	const selectedRow = $derived.by<FinderRow | null>(() => {
		if (view.stop) return rows.find((row) => row.stop.id === view.stop) ?? null;
		return desktop.current ? (shownRows[0] ?? null) : null;
	});

	const previewId = $props.id();
	const previewHeadingId = `stops-preview-${previewId}`;
	let previewOrigin: { stopId: string; button: HTMLElement; scrollY: number } | null = null;
	let resultsElement = $state<HTMLElement>();
	let focusedPreviewId = $state<string | null>(null);

	async function focusPreview(stopId: string): Promise<void> {
		await tick();
		if (!alive || view.stop !== stopId || selectedRow?.stop.id !== stopId) return;
		const heading = document.getElementById(previewHeadingId);
		heading?.focus({ preventScroll: true });
		heading?.scrollIntoView({ block: 'start' });
	}

	// A phone link can select a preview before its index arrives, without a click origin.
	$effect(() => {
		const stopId = view.stop;
		if (!stopId) {
			focusedPreviewId = null;
			return;
		}
		if (
			desktop.current ||
			selectedRow?.stop.id !== stopId ||
			untrack(() => focusedPreviewId) === stopId
		)
			return;
		focusedPreviewId = stopId;
		void focusPreview(stopId);
	});

	function previewButton(stopId: string | null): HTMLButtonElement | undefined {
		return [
			...(resultsElement?.querySelectorAll<HTMLButtonElement>('[data-stops-preview-id]') ?? []),
		].find((button) => button.dataset.stopsPreviewId === stopId);
	}

	async function openPreview(stop: StopIndexEntry, event: MouseEvent): Promise<void> {
		previewOrigin = {
			stopId: stop.id,
			button: event.currentTarget as HTMLElement,
			scrollY: window.scrollY,
		};
		focusedPreviewId = stop.id;
		apply({ stop: stop.id });
		await focusPreview(stop.id);
	}

	async function backToResults(): Promise<void> {
		const stopId = view.stop;
		const origin = previewOrigin;
		apply({ stop: null });
		await tick();
		if (origin?.stopId === stopId && origin.button.isConnected) {
			origin.button.focus({ preventScroll: true });
			window.scrollTo({ top: origin.scrollY });
			return;
		}
		const target = previewButton(stopId) ?? resultsElement;
		target?.focus({ preventScroll: true });
		target?.scrollIntoView({ block: target === resultsElement ? 'start' : 'center' });
	}
</script>

{#snippet finderCard(list: readonly FinderRow[], more: number)}
	<Card textSize="inherit" class="finder-card">
		<EntityList
			items={list}
			key={(row) => row.key}
			max={list.length}
			aria-label={t.listLabel}
			class="finder-list"
		>
			{#snippet row(row)}
				{@const record = recordFor(row.stop)}
				{@const name = stopDisplayName(row.stop.name)}
				<div class="finder-row" class:is-selected={selectedRow?.key === row.key}>
					{#snippet status()}
						{@const pending = record.state === 'pending'}
						{@const measured = record.figure != null && record.period != null}
						<!-- One shape in every state: the row keeps its size when the weekly file lands,
							     and the held room is never read. -->
						<span
							class="finder-figure"
							class:finder-held={pending}
							data-slot={pending ? undefined : measured ? 'stop-row-figure' : 'stop-row-state'}
							role={measured ? 'img' : undefined}
							aria-label={measured
								? t.row.figureLabel(record.figure ?? '', record.period ?? '')
								: undefined}
							aria-hidden={pending ? 'true' : undefined}
						>
							<span class="finder-figure-pct" class:finder-figure-none={!measured}>
								{measured ? record.figure : t.row.noShare}
							</span>
							<span class:finder-held={!measured} aria-hidden={measured ? undefined : 'true'}>
								{t.row.lateLabel}
							</span>
						</span>
					{/snippet}
					{#snippet action()}
						<button
							type="button"
							class="finder-button tap-press"
							data-stops-preview-id={row.stop.id}
							aria-label={t.previewStop(name)}
							onclick={(event) => openPreview(row.stop, event)}
						>
							{t.previewAction}
						</button>
					{/snippet}
					<EntityResultRow {status} {action}>
						<div class="finder-identity">
							<a class="finder-name readable-name" href={recordHref(row.stop, record)}>
								{name}
							</a>
							<p class="finder-meta">{metaText(row)}</p>
							{#if noLiveData(row.stop)}
								<p class="finder-capability" data-slot="stop-row-capability">
									{noLiveDataText}
								</p>
							{/if}
							<p class="finder-detail" data-slot="stop-row-detail">
								{detailText(record)}
							</p>
						</div>
					</EntityResultRow>
				</div>
			{/snippet}
		</EntityList>

		{#if more > 0}
			<div class="finder-more">
				<button
					type="button"
					class="finder-button tap-press"
					onclick={() => apply({ shown: view.shown + FINDER_PAGE_SIZE })}
				>
					{more === 1 ? t.showMoreLast : t.showMore(numberFmt.format(more))}
				</button>
			</div>
		{/if}
	</Card>
{/snippet}

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

	{#if !record}<FilterSection>
			{#if nearActive}
				<div class="finder-order-note">
					<span class="label-section text-sm font-semibold">{t.orderLabel}</span>
					<p class="finder-order-current">{t.orderNear}</p>
				</div>
			{:else if lateAvailable}
				<FilterGroup
					label={t.orderLabel}
					items={[{ key: 'late', label: t.orderLate }]}
					activeKey={view.order === 'late' ? 'late' : null}
					allLabel={defaultOrderLabel}
					allowDeselect={false}
					collapsible
					testIdPrefix="stops-sort"
					onSelect={(key) => narrow({ order: key === 'late' ? 'late' : 'default' })}
				/>
			{:else}
				<div class="finder-order-note">
					<span class="label-section text-sm font-semibold">{t.orderLabel}</span>
					<p class="finder-order-current">{defaultOrderLabel}</p>
					<button
						type="button"
						data-testid="stops-sort-late"
						disabled
						aria-describedby={`${previewId}-order`}
					>
						{t.orderLate}
					</button>
					<p id={`${previewId}-order`} class="finder-note">{t.orderUnavailable}</p>
				</div>
			{/if}
		</FilterSection>{/if}
{/snippet}

<ListingFrame
	presentation="reading"
	rule="dimension"
	heading={t.heading}
	subtitle={providerName}
	description={record ? dateRange(record.period, locale) : t.lede}
	filterLabel={t.controlsLabel}
	resultCountText={index.data ? countText : undefined}
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

	<!-- The stops are the page: a line catalogue that fails only leaves the line filter empty. The
	     list waits for that catalogue to settle so line names never change under the reader. -->
	<div class="finder-hold" use:hold.measure style:min-height={hold.minHeight}>
		{#if hold.active}
			<div class="finder-stack">
				<div class="finder-gauge" aria-hidden="true" inert>
					<div class="finder">
						<div class="finder-results">
							<p class="finder-count">{gaugeCount}</p>
							{@render finderCard(gaugeRows, FINDER_PAGE_SIZE)}
						</div>
					</div>
				</div>
				<EdgeState
					variant="skeleton"
					lang={locale}
					layout={desktop.current ? 'desktop' : 'mobile'}
				/>
			</div>
		{:else}
			<ResourceBoundary resource={index} lang={locale} isEmpty={(d) => d.stops.length === 0}>
				{#if !routesIndex.settled}
					<EdgeState
						variant="skeleton"
						lang={locale}
						layout={desktop.current ? 'desktop' : 'mobile'}
					/>
				{:else}
					<div class="finder" class:finder-record={record != null} data-slot="stops-finder">
						<div
							class="finder-results"
							bind:this={resultsElement}
							tabindex="-1"
							role="region"
							aria-label={t.listLabel}
						>
							<p class="finder-count" data-slot="finder-counts">{countText}</p>
							{#if lateActive && rankedWeek}
								<p class="finder-context" data-slot="finder-order-context">
									{t.orderContext(rankedWeek)}
								</p>
							{/if}
							{#if !record && rangeRequested}
								<p class="finder-notice" data-slot="finder-range-notice">{t.rangeUnsupported}</p>
							{/if}

							{#if lineLoading}
								<EdgeState
									variant="skeleton"
									lang={locale}
									layout={desktop.current ? 'desktop' : 'mobile'}
								/>
							{:else if noMatch}
								<StateNotice
									title={noMatchTitle}
									presentation="silo"
									role="status"
									aria-live="polite"
								>
									{#snippet action()}
										<button type="button" class="finder-button tap-press" onclick={clearFilters}>
											{t.clearFilters}
										</button>
									{/snippet}
								</StateNotice>
							{:else}
								{#if record}
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
											>{moreCount === 1
												? t.showMoreLast
												: t.showMore(numberFmt.format(moreCount))}</button
										>
									{/if}
								{:else}
									{@render finderCard(shownRows, moreCount)}
								{/if}
							{/if}
						</div>

						{#if !record && selectedRow}
							{@const record = recordFor(selectedRow.stop)}
							<div class="finder-preview-column">
								<StopsFinderPreview
									stop={selectedRow.stop}
									{record}
									{locale}
									{providerName}
									meta={metaText({ ...selectedRow, distanceM: null })}
									recordHref={recordHref(selectedRow.stop, record)}
									mapHref={mapHref(selectedRow.stop)}
									headingId={previewHeadingId}
									showBack={!desktop.current}
									onBack={backToResults}
								/>
							</div>
						{/if}
					</div>
				{/if}
			</ResourceBoundary>
		{/if}
	</div>
</ListingFrame>

<style>
	.finder {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1.5rem;
		align-items: start;
		min-width: 0;
	}
	/* A gauge and the skeleton it reserves room for share one cell; the taller sets the height. */
	.finder-stack {
		display: grid;
		align-items: start;
		min-width: 0;
	}
	.finder-stack > :global(*) {
		grid-area: 1 / 1;
		min-width: 0;
	}
	.finder-gauge {
		visibility: hidden;
	}
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
	.finder-note,
	.finder-notice,
	.finder-context,
	.finder-near-status {
		margin: 0;
		font-size: var(--text-small);
		line-height: 1.45;
		color: var(--muted-foreground);
		overflow-wrap: break-word;
	}
	.finder-count,
	.finder-context {
		font-variant-numeric: tabular-nums;
	}
	.finder-notice,
	.finder-near-status {
		padding: 0.5rem 0.75rem;
		border-left: 2px solid var(--border-brand);
	}
	:global(.card-surface.finder-card) {
		padding: 0;
		gap: 0;
	}
	.finder-line-filter,
	.finder-order-note {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 0;
	}
	.finder-line-filter :global([data-slot='combobox']) {
		width: 100%;
	}
	.finder-order-note p {
		margin: 0;
	}
	.finder-order-current {
		font-size: var(--text-small);
		color: var(--foreground);
	}
	.finder-order-note button {
		min-height: var(--size-tap-min);
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-md);
		background: var(--card);
		color: var(--muted-foreground);
		font: inherit;
		text-align: left;
	}
	.finder-order-note button:disabled {
		opacity: 0.7;
		cursor: not-allowed;
	}
	.finder-row {
		/* The row is its own container: the shared row's narrow layout stacks the record and the
		   action under the name instead of squeezing the name into a column. */
		container: entity-card / inline-size;
		min-width: 0;
	}
	.finder-row.is-selected {
		box-shadow: inset 2px 0 0 var(--accent-text);
	}
	.finder-identity {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
	}
	.finder-name {
		display: flex;
		min-height: var(--size-tap-min);
		align-items: center;
		color: var(--foreground);
		font-size: var(--text-body);
		font-weight: 600;
		text-decoration: none;
		overflow-wrap: anywhere;
	}
	.finder-name:hover,
	.finder-name:focus-visible {
		text-decoration: underline;
	}
	.finder-meta,
	.finder-capability,
	.finder-detail {
		margin: 0;
		font-size: var(--text-small);
		line-height: 1.45;
		color: var(--muted-foreground);
		overflow-wrap: break-word;
	}
	.finder-meta {
		font-variant-numeric: tabular-nums;
	}
	.finder-detail {
		/* The record's line keeps two lines of room while the weekly file loads, so rows never jump. */
		min-height: 2.9em;
	}
	.finder-figure {
		/* A fixed width keeps the name's column the same whatever the record says. */
		inline-size: 7.5rem;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		font-family: var(--font-mono);
		font-size: var(--text-caption);
		line-height: 1.3;
		font-variant-numeric: tabular-nums;
		text-align: right;
		color: var(--foreground);
		overflow-wrap: break-word;
	}
	.finder-figure-pct {
		font-size: var(--text-body);
		font-weight: 700;
	}
	.finder-figure-none {
		color: var(--muted-foreground);
	}
	.finder-held {
		visibility: hidden;
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
	.finder-more {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: center;
		padding: 0.75rem;
	}
	@media (min-width: 1024px) {
		.finder:not(.finder-record) {
			grid-template-columns: minmax(0, 58fr) minmax(0, 42fr);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.finder-button,
		.finder-way {
			transition: none;
		}
	}
</style>
