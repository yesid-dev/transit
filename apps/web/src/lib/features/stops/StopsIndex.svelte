<script lang="ts">
	import { getContext, onMount, tick, untrack } from 'svelte';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import { page } from '$app/state';
	import { beforeNavigate, goto, invalidateAll, pushState, replaceState } from '$app/navigation';
	import { FilterSummary, RoutePlate, SearchInput, filterCountText } from '@yesid/ui/brand';
	import { Button } from '@yesid/ui/button';
	import { Combobox, type ComboboxOption } from '@yesid/ui/combobox';
	import { ControlsRail, type SurfaceRailContext } from '@yesid/ui/layout';
	import { ShowMore, type DataTableColumn } from '@yesid/ui/table';
	import { intl, localizeHref, type Locale } from '#lib/i18n/index.ts';
	import { routeFor } from '#lib/nav/index.ts';
	import { foldSearchText, tokenMatchScore } from '#lib/search/normalize.ts';
	import { carryFrameState, recordStart } from '#lib/site/frameState.ts';
	import {
		countedUnit,
		dateRange,
		methodEvidence,
		recordPercent,
		recordStamp,
		sampleWithMinimum,
	} from '#lib/site/presenter.ts';
	import { formatTransitName, stopDisplayName } from '#lib/site/transitDisplay.ts';
	import {
		frameSurfaceRailContext,
		type RegisterFrameSurfaceRail,
	} from '#lib/components/shell/frameSurfaceRail.ts';
	import { nearestStops, type LatLon } from '#lib/components/map/nearbyStops.ts';
	import { isSlimStopsIndex } from '#lib/v1/repositories/stopsSlim.ts';
	import type { StopsRecord } from '#lib/server/finderRecord.ts';
	import type { StopSearchResult } from '#lib/server/stopListing.ts';
	import type { PublicCity } from '#lib/v1/schemas/providers.ts';
	import { overviewCopy } from '../home/overviewRecord.copy.ts';
	import { recordCounts } from '../home/overviewRecord.ts';
	import AboutFigures from '../record/AboutFigures.svelte';
	import RecordActionGroup from '../record/RecordActionGroup.svelte';
	import RecordAnswer from '../record/RecordAnswer.svelte';
	import RecordCard from '../record/RecordCard.svelte';
	import RecordDataTable from '../record/RecordDataTable.svelte';
	import RecordEvidenceLine from '../record/RecordEvidenceLine.svelte';
	import RecordGroup from '../record/RecordGroup.svelte';
	import RecordPending from '../record/RecordPending.svelte';
	import RecordScreen from '../record/RecordScreen.svelte';
	import RecordTableValue from '../record/RecordTableValue.svelte';
	import ScreenTitle from '../record/ScreenTitle.svelte';
	import { finderCells, finderCsv, finderRecordUrl, finderShare } from '../record/finderText.ts';
	import { recordStateFor } from '../record/recordStates.ts';
	import {
		pooledDays,
		punctualityWeighting,
		recordConnection,
		tally,
		timingBasis,
	} from '../record/recordText.ts';
	import { indexCopy } from './stops.copy.ts';
	import {
		stopPageSize,
		stopReading,
		stopLineCodes,
		type NearbyStop,
		stopListingView,
		type StopListing,
		type StopListingResult,
	} from './stopListing.ts';

	let {
		locale,
		record: initialRecord,
		listing: initialListing,
		view: initialView,
		provider,
	}: {
		locale: Locale;
		record: (Omit<StopsRecord, 'punctuality'> & { punctuality: Promise<StopListingResult> }) | null;
		listing: StopListing | null;
		view: ReturnType<typeof stopListingView>;
		provider: PublicCity | null;
	} = $props();
	const location = $derived(page.shallow?.url ?? page.url);
	const loadedSearch = $derived(
		page.state.stopsSearch?.href === location.pathname + location.search
			? page.state.stopsSearch.data
			: undefined,
	);
	const listing = $derived(loadedSearch ? loadedSearch.listing : initialListing);
	const view = $derived(
		loadedSearch?.view ?? initialView ?? stopListingView(new URLSearchParams(location.search)),
	);
	const record = $derived(
		loadedSearch
			? loadedSearch.finderRecord && {
					...loadedSearch.finderRecord,
					punctuality: Promise.resolve(loadedSearch.finderRecord.punctuality),
				}
			: initialRecord,
	);
	const t = (en: string, fr: string) => (locale === 'fr' ? fr : en);
	const copy = $derived(indexCopy[locale]);
	const about = $derived(overviewCopy[locale]);
	const operator = $derived(provider?.labels[locale].operator);
	const title = $derived(t('Find a stop', 'Trouver un arrêt'));
	const tableTitle = $derived(t('Stop results', 'Résultats de recherche d’arrêts'));
	const eventsHeader = $derived(t('Stop events', 'Passages aux arrêts'));
	const stopHeader = $derived(t('Stop', 'Arrêt'));
	const stamp = $derived(
		record ? { kind: 'record' as const, label: recordStamp(record.period, locale) } : undefined,
	);
	const subtitle = $derived(
		listing
			? [
					operator,
					t(`${tally(listing.count, locale)} stops`, `${tally(listing.count, locale)} arrêts`),
				]
					.filter(Boolean)
					.join(t(': ', '\u00a0: '))
			: operator,
	);
	const sentence = $derived(
		t(
			'Find a stop by its name, code or line.',
			'Trouvez un arrêt par son nom, son code ou sa ligne.',
		),
	);

	let results = $state<HTMLElement>();
	let initialResult = $state.raw<StopListingResult | null>(null);
	const result = $derived<StopListingResult | null>(
		loadedSearch ? (loadedSearch.finderRecord?.punctuality ?? null) : initialResult,
	);
	$effect(() => {
		const reading = initialRecord?.punctuality;
		let active = true;
		initialResult = null;
		void reading?.then((answer) => {
			if (active) initialResult = answer;
		});
		return () => {
			active = false;
		};
	});
	const cells = $derived(finderCells(result, 'stop'));
	const answer = $derived(result?.kind === 'answer' ? result.answer : undefined);
	const evidence = $derived(result?.kind === 'answer' ? result.answer.evidence : undefined);
	const counts = $derived(result?.totals?.counts);
	const observed = $derived(result?.totals?.observed);
	const sample = $derived(
		recordCounts(
			counts?.classified,
			counts?.ran,
			evidence?.days_included.length
				? countedUnit(evidence.days_included.length, 'day', locale)
				: '',
			locale,
		),
	);
	const pageUrl = $derived(new URL(location.href));
	const pinned = $derived(record ? finderRecordUrl(pageUrl, record.city, record.period) : pageUrl);
	function stopHref(id: string) {
		return carryFrameState(
			localizeHref(routeFor({ kind: 'stop', id }), locale, record?.city ?? provider?.id),
			pinned,
		);
	}

	let query = $state(untrack(() => view.query));
	let enhanced = $state(false);
	onMount(() => {
		enhanced = true;
	});
	let pendingQuery = $state<string | null>(null);
	let searchFailed = $state(false);
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	let searchRequest: AbortController | undefined;
	$effect(() => {
		if (pendingQuery === null && !searchFailed && untrack(() => query.trim()) !== view.query)
			query = view.query;
	});
	function cancelSearch() {
		clearTimeout(searchTimer);
		searchRequest?.abort();
		searchRequest = undefined;
	}
	$effect(() => cancelSearch);
	beforeNavigate(() => {
		cancelSearch();
		pendingQuery = null;
		searchFailed = false;
	});
	function listingUrl(nextQuery: string, route: string | null, shown = stopPageSize) {
		const url = new URL(location.href);
		for (const key of ['q', 'route', 'shown', 'stop', 'sort']) url.searchParams.delete(key);
		if (nextQuery.trim()) url.searchParams.set('q', nextQuery.trim());
		if (route) url.searchParams.set('route', route);
		if (shown > stopPageSize) url.searchParams.set('shown', String(shown));
		return url;
	}
	const clearUrl = $derived(listingUrl('', null));
	const searchId = 'stops-record-search';
	async function search(value: string, route: string | null = view.route, replace = true) {
		cancelSearch();
		searchFailed = false;
		const next = listingUrl(value, route);
		if (next.href === location.href) {
			pendingQuery = null;
			return;
		}
		pendingQuery = value;
		const request = new AbortController();
		searchRequest = request;
		const params = new SvelteURLSearchParams(next.search);
		params.set('details', 'search');
		params.set('lang', locale);
		if (provider) params.set('provider', provider.id);
		try {
			const response = await fetch(`/api/stops/slim?${params}`, { signal: request.signal });
			if (!response.ok) throw new Error('Stop search unavailable');
			const data: StopSearchResult = await response.json();
			if (!request.signal.aborted) {
				const update = replace ? replaceState : pushState;
				update(next, { ...page.state, stopsSearch: { href: next.pathname + next.search, data } });
			}
		} catch {
			if (!request.signal.aborted) searchFailed = true;
		} finally {
			if (searchRequest === request) {
				searchRequest = undefined;
				pendingQuery = null;
			}
		}
	}
	function queueSearch(value: string) {
		query = value;
		if (nearOrigin) nearShown = stopPageSize;
		cancelSearch();
		searchFailed = false;
		pendingQuery = value;
		searchTimer = setTimeout(() => void search(value), 250);
	}

	const lineOptions = $derived<ComboboxOption[]>(
		(listing?.lines ?? [])
			.map((line) => ({
				value: line.id,
				label: line.short,
				sublabel: line.long
					? formatTransitName(line.long, locale, provider?.name_separators)
					: undefined,
				search: foldSearchText(`${line.short} ${line.long ?? ''}`),
			}))
			.sort((a, b) => intl.collator(locale, { numeric: true }).compare(a.label, b.label)),
	);
	const register = getContext<RegisterFrameSurfaceRail | undefined>(frameSurfaceRailContext);
	const hasLines = $derived(lineOptions.length > 0);
	$effect(() => {
		if (hasLines) return untrack(() => register?.(filterRail));
	});

	type NearState = 'idle' | 'asking' | 'active' | 'denied' | 'timeout' | 'unavailable' | 'insecure';
	let nearState = $state<NearState>('idle');
	let nearOrigin = $state.raw<LatLon | null>(null);
	const updatingSearch = $derived(!nearOrigin && pendingQuery !== null);
	let nearStops = $state.raw<readonly NearbyStop[]>([]);
	let nearShown = $state(stopPageSize);
	let nearRequest = 0;
	const nearContext = $derived(`${provider?.id}|${record?.period.from}|${record?.period.to}`);
	function stopNear() {
		nearRequest++;
		nearOrigin = null;
		nearState = 'idle';
		nearShown = stopPageSize;
	}
	$effect(() => {
		void nearContext;
		untrack(stopNear);
		return () => {
			nearRequest++;
		};
	});
	function askNear() {
		if (!window.isSecureContext) {
			nearState = 'insecure';
			return;
		}
		if (!navigator.geolocation) {
			nearState = 'unavailable';
			return;
		}
		nearState = 'asking';
		const request = ++nearRequest;
		navigator.geolocation.getCurrentPosition(
			async ({ coords }) => {
				if (request !== nearRequest) return;
				try {
					const params = new SvelteURLSearchParams({
						provider: provider?.id ?? '',
						details: 'record',
					});
					if (record) {
						params.set('recordFrom', record.period.from);
						params.set('recordTo', record.period.to);
					}
					const response = await fetch(`/api/stops/slim?${params}`);
					const index: { stops: NearbyStop[] } = await response.json();
					if (!response.ok || !isSlimStopsIndex(index)) throw new Error('Stop index unavailable');
					if (request !== nearRequest) return;
					if (view.route) await search(query, null, false);
					if (request !== nearRequest) return;
					nearStops = index.stops;
					nearOrigin = { lat: coords.latitude, lon: coords.longitude };
					nearState = 'active';
				} catch {
					if (request === nearRequest) nearState = 'unavailable';
				}
			},
			(error) => {
				if (request !== nearRequest) return;
				nearState =
					error.code === error.PERMISSION_DENIED
						? 'denied'
						: error.code === error.TIMEOUT
							? 'timeout'
							: 'unavailable';
			},
			{ enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 },
		);
	}
	const nearMessage = $derived(
		{
			idle: '',
			asking: copy.nearAsking,
			active: copy.nearActive,
			denied: copy.nearDenied,
			timeout: copy.nearTimeout,
			unavailable: copy.nearUnavailable,
			insecure: copy.nearInsecure,
		}[nearState],
	);
	const nearby = $derived.by(() => {
		if (!nearOrigin) return [];
		const folded = foldSearchText(query);
		const candidates = nearStops.filter(
			(stop) =>
				!folded ||
				tokenMatchScore([stop.name, stop.code, stop.id, ...stop.lineCodes], folded) != null,
		);
		return nearestStops(nearOrigin, candidates, candidates.length, 1000);
	});
	const total = $derived(nearOrigin ? nearby.length : (listing?.total ?? 0));
	const declared = $derived(
		new Set(
			(listing?.lines ?? [])
				.filter((line) =>
					provider?.lines_without_live_data.some(
						(gap) =>
							gap.route_ids.includes(line.id) || gap.route_types.some((type) => type === line.type),
					),
				)
				.map(({ id }) => id),
		),
	);
	const stops = $derived(
		nearOrigin
			? nearby.slice(0, nearShown).map((stop) => ({
					...stop,
					detail: `${tally(Math.round(stop.distanceM / 10) * 10, locale)} m`,
				}))
			: (listing?.rows ?? []).map((stop) => ({ ...stop, detail: undefined, reading: undefined })),
	);
	const rows = $derived(
		stops.map((stop) => {
			const reading = stop.reading ?? stopReading(cells.get(stop.id), answer);
			const state =
				!reading.state && stop.routeIds.length && stop.routeIds.every((id) => declared.has(id))
					? 'no_live_data'
					: recordStateFor(reading.state);
			return {
				...stop,
				label: stopDisplayName(stop.name),
				lineCodes: stopLineCodes(stop.lineCodes, locale),
				href: stopHref(stop.id),
				state,
				share: reading.share,
				events: reading.events,
				onTime: reading.onTime,
				minimum: reading.minimum,
				measured: reading.state === 'measured',
			};
		}),
	);
	type Row = (typeof rows)[number];
	const leadingColumn: DataTableColumn<Row> = {
		key: 'code',
		header: 'Code',
		cell: codeCell,
		width: '8ch',
	};
	const columns = $derived<DataTableColumn<Row>[]>([
		{ key: 'lines', header: t('Lines', 'Lignes'), cell: linesCell },
		{ key: 'onTime', header: about.onTime, numeric: true, cell: shareCell },
		{ key: 'events', header: eventsHeader, numeric: true, cell: eventsCell },
	]);
	const countLabel = $derived({
		singular: t('{count} stop', '{count} arrêt'),
		plural: t('{count} stops', '{count} arrêts'),
	});
	const pageLabels = $derived({
		showing: (shown: number, all: number) =>
			t(
				`Showing ${tally(shown, locale)} of ${tally(all, locale)}`,
				`${tally(shown, locale)} sur ${tally(all, locale)}`,
			),
		more: (count: number) =>
			t(`Show ${tally(count, locale)} more`, `Afficher ${tally(count, locale)} de plus`),
	});
	const archived = $derived(
		!nearOrigin && !total && view.query && cells.has(view.query) ? view.query : null,
	);
	const address = $derived(localizeHref('/search', locale, provider?.id));
	async function showMore(count: number) {
		const before = rows.length;
		if (nearOrigin) nearShown += count;
		else await goto(listingUrl(view.query, view.route, before + count), { reset: false });
		await tick();
		results?.querySelectorAll<HTMLAnchorElement>('tbody a')[before]?.focus();
	}
</script>

{#snippet filterRail(context: SurfaceRailContext)}
	{@const label = t('Line', 'Ligne')}
	<ControlsRail label={t('Filter', 'Filtrer')}>
		<div class="grid w-full min-w-0 gap-1">
			<p aria-hidden="true" class="text-small text-muted-foreground">{label}</p>
			<Combobox
				options={lineOptions}
				bind:value={
					() => view.route,
					(value) => {
						stopNear();
						void search(query, value ?? null, false);
						context.closeSheet();
					}
				}
				{label}
				placeholder={t('All', 'Toutes')}
				clearLabel={copy.lineClear}
				emptyLabel={copy.lineEmpty}
				fold={foldSearchText}
			/>
		</div>
	</ControlsRail>
{/snippet}

{#snippet codeCell(row: Row)}<RecordTableValue
		{locale}
		text={row.code || null}
		state="not_published"
	/>{/snippet}
{#snippet linesCell(row: Row)}
	<span class="inline-flex flex-wrap gap-1"
		>{#each row.lineCodes as code (code)}<RoutePlate {code} />{/each}</span
	>
{/snippet}
{#snippet shareCell(row: Row)}
	{#if row.share !== null}<strong>{recordPercent(row.share, locale)}</strong>
	{:else}<RecordTableValue
			{locale}
			text={record && (!result || result.kind === 'busy')
				? t('Calculating…', 'Calcul en cours…')
				: result && result.kind !== 'answer'
					? t('Unavailable', 'Indisponible')
					: null}
			state={row.state}
		/>{/if}
{/snippet}
{#snippet eventsCell(row: Row)}
	{#if row.events !== null}
		{row.minimum === null
			? tally(row.events, locale)
			: sampleWithMinimum(tally(row.events, locale), row.minimum, locale)}
	{/if}
{/snippet}
{#snippet evidenceFoot()}
	{#if evidence}<RecordEvidenceLine
			{locale}
			{evidence}
			sample={t(
				'Each row is counted over the chosen dates',
				'Chaque rangée est comptée sur les dates choisies',
			)}
		/>{/if}
{/snippet}
{#snippet resultActions()}
	{#if record && result && rows.length}
		{@const href = new URL('#stop-results', pinned).href}
		{@const headers = [
			t('Stop ID', 'Identifiant de l’arrêt'),
			'Code',
			stopHeader,
			t('On-time share', 'Part à l’heure'),
			t('Classified stop events', 'Passages classés'),
			t('On-time events', 'Passages à l’heure'),
			t('Status', 'État'),
		]}
		{@const csvRows = rows.map((row) => [
			row.id,
			row.code ?? '',
			row.label,
			row.share,
			row.measured ? row.events : null,
			row.onTime,
			row.share === null ? finderShare(cells.get(row.id), result, 'on_time', locale).text : '',
		])}
		{#snippet citation()}
			<p>
				Transit. {tableTitle}. {dateRange(record.period, locale)}.{evidence
					? ` ${methodEvidence(evidence, locale)}`
					: ''}
			</p>
			<a class="inline-flex min-h-11 items-center text-primary underline" {href}>
				<span
					>{#each href.split(/(?<=[/?&=#_.:%-])/u) as part, index (index)}{part}<wbr />{/each}</span
				>
			</a>
		{/snippet}
		<RecordActionGroup
			{locale}
			{href}
			{citation}
			files={[
				{
					label: tableTitle,
					href: finderCsv(
						headers,
						csvRows,
						locale,
						record.city,
						record.period,
						evidence ? [evidence] : [],
					),
					download: `stop-results-${record.period.from}-${record.period.to}.csv`,
				},
			]}
		/>
	{/if}
{/snippet}

<RecordScreen class="min-w-0">
	<RecordGroup><ScreenTitle title={copy.heading} {subtitle} /></RecordGroup>
	<div class="min-w-0" data-slot="screen-content">
		<RecordGroup density="compact">
			<div data-slot="screen-answer">
				<RecordAnswer
					{locale}
					value={null}
					{sentence}
					actions={record && result && rows.length && !updatingSearch && !searchFailed
						? resultActions
						: undefined}
					time={stamp}
					evidence={evidence
						? {
								sample: sample ?? '',
								lastGood: result?.kind === 'answer' && result.lastGood,
							}
						: undefined}
				/>
			</div>
			<RecordCard {title} {stamp} interactive evidence={evidence ? evidenceFoot : undefined}>
				<div class="grid min-w-0 grid-cols-1 gap-3">
					<form
						method="GET"
						action={location.pathname}
						class="max-w-xl"
						onsubmit={(event) => {
							event.preventDefault();
							if (!nearOrigin) void search(query, view.route, false);
						}}
					>
						{#each [...location.searchParams].filter(([key]) => !['q', 'shown', 'stop', 'sort'].includes(key)) as [key, value], i (i)}
							<input type="hidden" name={key} {value} />
						{/each}
						<SearchInput
							id={searchId}
							name="q"
							testId="stops-filter-input"
							visibleLabel
							textSize="body"
							label={t('Name, code or line', 'Nom, code ou ligne')}
							placeholder={t(
								'For example Laurier, 52847 or 51…',
								'Par exemple Laurier, 52847 ou 51…',
							)}
							value={query}
							oninput={(event) => queueSearch(event.currentTarget.value)}
						/>
						<noscript
							><Button type="submit" variant="outline">{t('Search', 'Rechercher')}</Button
							></noscript
						>
					</form>
					<div class="flex flex-wrap gap-2" data-slot="stops-nearby">
						<Button
							variant="outline"
							size="cta-sm"
							wrap
							class="min-h-11"
							disabled={nearState === 'asking'}
							onclick={nearOrigin ? stopNear : askNear}
							>{nearOrigin ? copy.nearClear : copy.nearMe}</Button
						>
						<Button variant="outline" size="cta-sm" wrap class="min-h-11" href={address}
							>{copy.nearAddress}</Button
						>
					</div>
					<p role="status" aria-live="polite" data-slot="stops-near-status" class="empty:hidden">
						{nearMessage}
					</p>
					<p class="sr-only" role="status">
						{listing && !updatingSearch && !searchFailed
							? filterCountText(total, countLabel, locale)
							: ''}
					</p>
					{#if listing && !updatingSearch && (view.query || view.route || nearOrigin)}
						<FilterSummary
							count={total}
							{countLabel}
							{locale}
							clearLabel={copy.clearFilters}
							canClear={enhanced}
							onClear={() => {
								stopNear();
								query = '';
								void search('', null, false);
							}}
						/>
						<noscript
							><Button href={clearUrl.pathname + clearUrl.search} variant="outline"
								>{copy.clearFilters}</Button
							></noscript
						>
					{/if}
					<section id="stop-results" class="min-w-0" aria-label={tableTitle} bind:this={results}>
						{#if updatingSearch}<p role="status">{t('Finding stops…', 'Recherche d’arrêts…')}</p>
						{:else if searchFailed}<p role="status">
								{t(
									'Stop search is temporarily unavailable.',
									'La recherche d’arrêts est temporairement indisponible.',
								)}
							</p>
							<Button variant="outline" onclick={() => queueSearch(query)}
								>{t('Retry', 'Réessayer')}</Button
							>
						{:else if !listing}<p role="status">
								{t(
									'The stop list is temporarily unavailable.',
									'La liste des arrêts est temporairement indisponible.',
								)}
							</p>
							<Button variant="outline" onclick={() => void invalidateAll()}
								>{t('Retry', 'Réessayer')}</Button
							>
						{:else if archived}<p>
								{t(
									'This stop is outside the current timetable.',
									'Cet arrêt ne figure plus dans l’horaire actuel.',
								)}
								<a
									class="inline-flex min-h-11 items-center text-primary underline"
									href={stopHref(archived)}>{t('Open its record', 'Ouvrir son bilan')}</a
								>
							</p>
						{:else if !rows.length}<p>
								{nearOrigin && !query
									? copy.nearNone
									: view.query
										? copy.noMatch(view.query)
										: view.route
											? copy.noLineStops
											: copy.noMatchFilters}
							</p>
						{:else}
							<RecordDataTable
								{locale}
								title={tableTitle}
								rowHeader={stopHeader}
								value="onTime"
								{leadingColumn}
								{columns}
								{rows}
								pageSize={0}
							/>
							<ShowMore
								shown={rows.length}
								{total}
								pageSize={stopPageSize}
								labels={pageLabels}
								onMore={(count) => void showMore(count)}
							/>
						{/if}
						{#if record && !result}{#key record}<RecordPending
									{locale}
									answer={record.punctuality}
								/>{/key}
						{:else if result?.kind === 'busy'}<RecordPending {locale} busy />
						{:else if result && result.kind !== 'answer'}<p>
								{recordConnection[result.kind][locale]}
							</p>{/if}
					</section>
				</div>
			</RecordCard>
		</RecordGroup>
		<RecordGroup>
			<AboutFigures
				title={about.about}
				compact
				fields={[
					{
						key: 'period',
						label: about.period,
						text: record ? dateRange(record.period, locale) : null,
					},
					{
						key: 'counted',
						label: about.counted,
						text: evidence
							? [
									sample ? `${sample}.` : '',
									punctualityWeighting[locale],
									record?.period.from !== record?.period.to ? pooledDays[locale] : '',
								]
									.filter(Boolean)
									.join(' ')
							: null,
					},
					{
						key: 'observed',
						label: about.observed,
						text: evidence
							? [
									observed
										? about.observedShare(
												recordPercent(observed.share, locale),
												tally(observed.scheduled, locale),
											)
										: '',
									timingBasis(counts, locale),
									result?.kind === 'answer' ? result.answer.coverage_note?.[locale] : '',
								]
									.filter(Boolean)
									.join(' ')
							: null,
					},
					{ key: 'means', label: about.means, text: about.definition },
					{
						key: 'method',
						label: about.methodRow,
						text: null,
						link: { href: localizeHref('/metrics', locale, provider?.id), label: about.method },
					},
					{
						key: 'source',
						label: about.source,
						text: operator
							? `${about.feeds(operator)} ${about.recordStart(dateRange({ from: recordStart(provider), to: recordStart(provider) }, locale))}`
							: null,
					},
				]}
			/>
		</RecordGroup>
	</div>
</RecordScreen>
