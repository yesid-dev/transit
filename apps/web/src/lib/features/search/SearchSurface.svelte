<script lang="ts">
	import { stopDisplayName } from '#lib/site/transitDisplay.ts';
	import { hasOccupancy } from '#lib/site/transitDisplay.ts';
	import { liveReader } from '#lib/v1/adapter/index.ts';
	import { livePresentation } from '#lib/v1/live/livePresentation.ts';

	import { verdictCopy } from '#lib/v1/verdict.copy.ts';
	import { stopReliabilityCopy } from '#lib/features/stops/reliability/stops-reliability.copy.ts';
	import { onMount, tick, untrack } from 'svelte';
	import { page } from '$app/state';
	import { afterNavigate } from '$app/navigation';
	import { getLocale, getLocalizeHref, type Locale } from '#lib/i18n/index.ts';
	import { desktop } from '@yesid/ui/state';
	import { createResource } from '#lib/v1/resource.svelte.ts';
	import { getRoutesIndex, getStopsIndex } from '#lib/v1/repositories/static.ts';
	import { getV1Context } from '#lib/v1/boot.ts';
	import { providerHasAlerts } from '#lib/v1/providers.ts';
	import { createLiveStore } from '#lib/v1/live/store.svelte.ts';
	import { createReliabilityLoader } from '#lib/v1/reliabilitySnapshot.svelte.ts';
	import type { RouteIndexEntry, Vehicle, StatusCode, OccupancyCode } from '#lib/v1/index.ts';
	import {
		EntityList,
		LineStopResult,
		ReliabilityBadge,
		SearchControls,
		TransitEntityRow,
		type SearchScopeKey,
	} from '#lib/components/surface/index.ts';
	import { Masthead, Surface } from '@yesid/ui/layout';
	import { SearchInput } from '@yesid/ui/brand';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { EdgeState } from '#lib/components/edge/index.ts';
	import { FreshnessStamp } from '#lib/components/surface/index.ts';
	import MetricInfo from '#lib/features/metrics/MetricInfo.svelte';
	import { headerSearchCopy } from '#lib/components/shell/headerSearch.copy.ts';
	import { metricName } from '#lib/metrics.ts';
	import { mirrorSearchParams } from '#lib/site/urlMirror.ts';
	import { createAddressLookup } from '#lib/search/addressLookup.svelte.ts';
	import { sitePages } from '#lib/search/sitePages.ts';
	import { addressHits, searchHitHref, searchTransit } from '#lib/search/transitSearch.ts';
	import {
		stopModeHint,
		stopModeTag,
		routeModeHint,
		TRANSIT_MODE_FILTERS,
		type TransitModeKey,
	} from '#lib/search/stopMode.ts';
	import { routeColor } from '#lib/search/routeColor.ts';
	import { STATUS_LABELS, OCCUPANCY_LABELS } from '#lib/v1/enumLabels.ts';
	import VehicleResultRow from './VehicleResultRow.svelte';
	import { copy, searchExamples, type GroupKind } from './search.copy';

	const v1 = getV1Context();
	const locale: Locale = getLocale();
	const localizeHref = getLocalizeHref();
	const t = $derived(copy[locale]);
	const say = $derived(headerSearchCopy[locale]);
	const edgeLayout = $derived(desktop.current ? 'desktop' : 'mobile');
	const uid = $props.id();

	const routes = createResource(() => getRoutesIndex());
	const stops = createResource(() => getStopsIndex());

	const live = createLiveStore(v1.manifest, liveReader, { families: ['vehicles'] });
	const occupancyAvailable = $derived(
		hasOccupancy(v1.manifest.provider, live.vehicles?.vehicles ?? []),
	);
	onMount(() => {
		live.start();
		return () => live.stop();
	});

	const routeReliability = createReliabilityLoader('route', verdictCopy[locale]);
	const stopReliability = createReliabilityLoader('stop', stopReliabilityCopy[locale].verdict);
	const observeRouteReliability = routeReliability.reliability;
	const observeStopReliability = stopReliability.reliability;

	/** Rows per group while every group shows; a group's own view reveals STEP more at a time. */
	const PREVIEW = 6;
	const STEP = 50;
	const KINDS = ['route', 'stop', 'page', 'vehicle'] as const satisfies readonly GroupKind[];

	// The page keeps its place in the URL: query, kind, modes and the rows revealed.
	const kindFrom = (value: string | null): SearchScopeKey =>
		(KINDS as readonly string[]).includes(value ?? '') ? (value as GroupKind) : 'all';
	const modesFrom = (value: string | null): TransitModeKey[] =>
		(value ?? '')
			.split(',')
			.filter((mode): mode is TransitModeKey =>
				TRANSIT_MODE_FILTERS.some((filter) => filter.key === mode),
			);
	/** A whole number of 50-row steps; anything else (junk, fractions, overflow) is the first step. */
	function rowsFrom(value: string | null): number {
		const n = /^[1-9]\d*$/.test(value ?? '') ? Number(value) : NaN;
		return Number.isSafeInteger(n) && n >= STEP && n % STEP === 0 ? n : STEP;
	}
	const restored = new URLSearchParams(page.url.search);
	let query = $state(restored.get('q') ?? '');
	let scope = $state<SearchScopeKey>(kindFrom(restored.get('kind')));
	const modes = new SvelteSet<TransitModeKey>(modesFrom(restored.get('mode')));
	let rows = $state(rowsFrom(restored.get('rows')));
	// The route is reused when the header or history opens another /search URL: take its place.
	afterNavigate(({ type, to }) => {
		if (type === 'enter' || !to) return;
		const params = to.url.searchParams;
		query = params.get('q') ?? '';
		scope = kindFrom(params.get('kind'));
		modes.clear();
		for (const mode of modesFrom(params.get('mode'))) modes.add(mode);
		rows = rowsFrom(params.get('rows'));
	});

	const pages = sitePages({
		alerts: page.data?.provider ? providerHasAlerts(page.data.provider) : null,
	});
	const matches = $derived(
		searchTransit(
			{ surface: 'page', query, modes },
			{
				routes: routes.data?.routes,
				stops: stops.data?.stops,
				vehicles: live.vehicles?.vehicles,
				pages,
			},
		),
	);
	const text = $derived(query.trim());
	const hasQuery = $derived(matches.query.length > 0);

	const presentation = $derived(
		livePresentation({
			familyStates: live.familyStates,
			families: ['vehicles'],
			locale,
			page: 'map',
		}),
	);

	/** A group that has not loaded, or could not, is never counted: its total is null. */
	type GroupState = 'loading' | 'failed' | 'ready';
	const indexState = (resource: typeof routes | typeof stops): GroupState =>
		resource.error ? 'failed' : resource.data ? 'ready' : 'loading';
	/** A failed fetch or refresh is failed, even with an older payload kept: that is not a count. */
	function vehicleState(): GroupState {
		const family = live.familyStates?.vehicles;
		if (family?.phase === 'failed' || family?.health?.notice === 'refresh-unavailable')
			return 'failed';
		return live.vehicles ? 'ready' : 'loading';
	}
	const groups = $derived.by(() => {
		const state: Record<GroupKind, GroupState> = {
			route: indexState(routes),
			stop: indexState(stops),
			page: 'ready',
			vehicle: vehicleState(),
		};
		const items = {
			route: matches.routes,
			stop: matches.stops,
			page: matches.pages,
			vehicle: matches.vehicles,
		};
		return KINDS.map((kind) => ({
			kind,
			state: state[kind],
			total: state[kind] === 'ready' ? items[kind].length : null,
		}));
	});
	const liveNotice = $derived(
		presentation.notice.kind === 'none' ? null : presentation.notice.message,
	);
	const shownGroups = $derived(
		scope === 'all'
			? groups.filter(
					(group) =>
						(group.total ?? 0) > 0 ||
						(group.kind === 'vehicle'
							? liveNotice != null || group.state === 'failed'
							: group.kind !== 'page' && group.state !== 'ready'),
				)
			: groups.filter((group) => group.kind === scope),
	);
	const noMatch = $derived(scope === 'all' && groups.every((group) => group.total === 0));

	/** The rows the open group shows: never past its last step once its total is known. */
	const openTotal = $derived(groups.find((group) => group.kind === scope)?.total ?? null);
	const shownRows = $derived(
		openTotal === null ? rows : Math.min(rows, Math.max(STEP, Math.ceil(openTotal / STEP) * STEP)),
	);
	// Only this page's own state is written back; a navigation is read first, never overwritten.
	$effect(() => {
		const state = {
			q: query.trim() || null,
			kind: scope === 'all' ? null : scope,
			mode: [...modes].join(',') || null,
			rows: scope !== 'all' && shownRows > STEP ? String(shownRows) : null,
		};
		untrack(() => mirrorSearchParams(state));
	});

	const scopeSegments = $derived([
		{ key: 'all' as const, label: t.scopeAll },
		...groups.map((group) => {
			const label = labelFor(group.kind);
			return {
				key: group.kind,
				label: group.total === null ? label : t.scopeCount(label, group.total),
			};
		}),
	]);
	function labelFor(kind: GroupKind): string {
		return {
			route: t.linesLabel,
			stop: t.stopsLabel,
			page: t.pagesLabel,
			vehicle: t.vehiclesLabel,
		}[kind];
	}
	function heading(kind: GroupKind, total: number | null): string {
		return total === null ? labelFor(kind) : `${labelFor(kind)} · ${total}`;
	}
	function visibleCount(total: number): number {
		return Math.min(total, scope === 'all' ? PREVIEW : shownRows);
	}

	// Revealing rows moves focus to the first new one, so the reader carries on from there.
	const sections: Partial<Record<GroupKind, HTMLElement>> = {};
	async function reveal(kind: GroupKind, firstNew: number, next: () => void): Promise<void> {
		next();
		await tick();
		sections[kind]
			?.querySelectorAll<HTMLElement>('[data-slot="entity-list"] > li')
			[firstNew]?.querySelector<HTMLElement>('a')
			?.focus();
	}
	function retry(kind: GroupKind): void {
		if (kind === 'route') routes.reload();
		else if (kind === 'stop') stops.reload();
		else if (kind === 'vehicle') void live.refresh({ force: true });
	}
	const showAll = (kind: GroupKind) =>
		reveal(kind, PREVIEW, () => {
			scope = kind;
			rows = STEP;
		});
	const showMore = (kind: GroupKind) => {
		const from = shownRows;
		return reveal(kind, from, () => (rows = from + STEP));
	};

	const lookup = createAddressLookup(() => ({ providerId: v1.manifest.provider, locale }));
	const addressRow = $derived(scope === 'all' && hasQuery ? lookup.row(text) : null);
	const asked = $derived(lookup.for(text));
	const addresses = $derived(
		scope === 'all' && asked?.state === 'done' ? addressHits(asked.found) : [],
	);
	const addressStatus = $derived(
		addressRow === 'loading'
			? say.addressesLoading
			: addressRow === 'none'
				? say.addressesNone(text)
				: addressRow === 'failed'
					? say.addressesFailed
					: '',
	);
	// Found addresses take focus, as in the header (#1060 E17); otherwise focus stays on the row.
	let addressSection = $state<HTMLElement>();
	async function askAddresses(): Promise<void> {
		if (addressRow !== 'ask') return;
		await lookup.ask(text);
		await tick();
		addressSection?.querySelector<HTMLElement>('a')?.focus();
	}
	const addressHref = (hit: (typeof addresses)[number]) =>
		localizeHref(searchHitHref(hit, { path: '/search', params: new URLSearchParams() }), locale);

	const stopNameById = $derived.by<SvelteMap<string, string>>(() => {
		const m = new SvelteMap<string, string>();
		for (const s of stops.data?.stops ?? []) m.set(s.id, stopDisplayName(s.name));
		return m;
	});
	function nextStopName(v: Vehicle): string | null {
		return v.next_stop ? (stopNameById.get(v.next_stop) ?? null) : null;
	}

	function routeTitle(r: RouteIndexEntry): string {
		return r.short || r.id;
	}

	const statusLabelFor = (s: StatusCode): string => STATUS_LABELS[locale][s];
	const occupancyLabelFor = (o: OccupancyCode | null | undefined): string | null =>
		o ? OCCUPANCY_LABELS[locale][o] : null;
</script>

{#snippet groupSection(group: (typeof groups)[number])}
	{@const id = `${uid}-${group.kind}`}
	<section class="search-group" aria-labelledby={id} bind:this={sections[group.kind]}>
		<div class="search-group-head">
			<h2 class="search-group-label" {id}>{heading(group.kind, group.total)}</h2>
			{#if group.kind === 'route'}
				<MetricInfo metricKey="otp" {locale} name="OTP" side="bottom" />
			{:else if group.kind === 'vehicle' && group.total}
				{#if occupancyAvailable}<MetricInfo
						metricKey="occupancy"
						{locale}
						name={metricName('occupancy', locale)}
						side="bottom"
					/>{/if}
				<MetricInfo
					metricKey="avgDelay"
					{locale}
					name={metricName('avgDelay', locale)}
					side="bottom"
				/>
			{/if}
		</div>
		{#if group.kind === 'vehicle'}
			{#if group.state === 'ready'}
				<FreshnessStamp variant="live" presentation={presentation.stamp} {locale} />
			{/if}
			{#if liveNotice}<p class="search-group-note" role="status">{liveNotice}</p>{/if}
		{/if}
		{#if group.state === 'failed'}
			<EdgeState
				variant="error-v1"
				lang={locale}
				layout={edgeLayout}
				onRetry={() => retry(group.kind)}
			/>
		{:else if group.state === 'loading'}
			{#if group.kind !== 'vehicle' || !liveNotice}
				<EdgeState variant="skeleton" lang={locale} layout={edgeLayout} />
			{/if}
		{:else if group.total === 0 || group.total === null}
			{#if group.kind !== 'vehicle' || !liveNotice}
				<p class="search-group-note">{t.none(group.kind, text)}</p>
			{/if}
		{:else}
			{@const shown = visibleCount(group.total)}
			{#if group.kind === 'route'}
				<EntityList
					grid
					cards
					interactive
					items={matches.routes.slice(0, shown)}
					key={(r) => r.id}
					max={shown}
				>
					{#snippet row(r)}
						{@const hint = routeModeHint(r.type)}
						<div use:observeRouteReliability={{ id: r.id, known: r.reliability }}>
							<LineStopResult
								presentation="legacy-search"
								target={{ kind: 'line', id: r.id }}
								{locale}
								glyph={hint.glyph}
								swatch={routeColor(r.color)}
								tag={hint.tag ?? undefined}
								title={routeTitle(r)}
								subtitle={r.long ?? undefined}
							>
								{#snippet status()}
									<ReliabilityBadge named snapshot={routeReliability.get(r.id)} {locale} />
								{/snippet}
							</LineStopResult>
						</div>
					{/snippet}
				</EntityList>
			{:else if group.kind === 'stop'}
				<EntityList
					grid
					cards
					interactive
					items={matches.stops.slice(0, shown)}
					key={(s) => s.id}
					max={shown}
				>
					{#snippet row(s)}
						{@const hint = stopModeHint(s)}
						{@const tag = stopModeTag(s)}
						<div use:observeStopReliability={s.id}>
							<LineStopResult
								presentation="legacy-search"
								target={{ kind: 'stop', id: s.id }}
								{locale}
								glyph={hint.glyph}
								tag={tag ?? undefined}
								title={stopDisplayName(s.name)}
								subtitle={s.code ? `${say.kind.stop} ${s.code}` : undefined}
								routes={s.routes}
							>
								{#snippet status()}
									<ReliabilityBadge named snapshot={stopReliability.get(s.id)} {locale} />
								{/snippet}
							</LineStopResult>
						</div>
					{/snippet}
				</EntityList>
			{:else if group.kind === 'page'}
				<EntityList
					grid
					cards
					interactive
					items={matches.pages.slice(0, shown)}
					key={(p) => p.href}
					max={shown}
				>
					{#snippet row(p)}
						<TransitEntityRow
							href={localizeHref(p.href, locale)}
							title={p.label[locale]}
							subtitle={p.group?.[locale]}
						/>
					{/snippet}
				</EntityList>
			{:else}
				<EntityList
					grid
					cards
					interactive
					items={matches.vehicles.slice(0, shown)}
					key={(v) => v.id}
					max={shown}
				>
					{#snippet row(v)}
						<VehicleResultRow
							{occupancyAvailable}
							vehicle={v}
							{locale}
							nextStopName={nextStopName(v)}
							copy={t.vehicle}
							statusLabel={statusLabelFor(v.status)}
							occupancyLabel={occupancyLabelFor(v.occupancy)}
						/>
					{/snippet}
				</EntityList>
			{/if}
			{#if scope === 'all' && group.total > shown}
				<button type="button" class="search-group-more" onclick={() => showAll(group.kind)}
					>{t.showAll(group.kind, group.total)}</button
				>
			{:else if group.total > shown}
				<div class="search-group-foot">
					<span class="search-group-shown">{t.shown(shown, group.total)}</span>
					<button type="button" class="search-group-more" onclick={() => showMore(group.kind)}
						>{t.showMore(group.kind, Math.min(STEP, group.total - shown))}</button
					>
				</div>
			{/if}
		{/if}
	</section>
{/snippet}

<Surface class="surface">
	<Masthead kicker={t.kicker} heading={t.heading} lede={t.lede}>
		<SearchInput
			label={t.inputLabel}
			placeholder={t.inputPlaceholder}
			bind:value={
				() => query,
				(next) => {
					query = next;
					rows = STEP;
				}
			}
		/>

		<SearchControls
			filters={hasQuery}
			scopeLabel={t.scopeLabel}
			{scopeSegments}
			bind:scope={
				() => scope,
				(next) => {
					scope = next;
					rows = STEP;
				}
			}
			modeLabel={t.modeLabel}
			{modes}
		/>
	</Masthead>

	{#if !hasQuery}
		<div class="search-idle" role="note">
			<span class="search-idle-glyph" aria-hidden="true">⌕</span>
			<p class="search-idle-title">{t.idleTitle}</p>
			<p class="search-idle-body">{t.idleBody}</p>
			<div class="search-census">
				<div class="search-census__examples">
					<span class="search-census__examples-label">{t.census.examplesLabel}</span>
					<div class="search-census__chips">
						{#each searchExamples(v1.manifest.provider, locale) as example (example)}
							<button type="button" class="search-census__chip" onclick={() => (query = example)}
								>{example}</button
							>
						{/each}
					</div>
				</div>
				<p class="search-browse">
					<a href={localizeHref('/lines', locale)}>{say.browseLines}</a>
					<a href={localizeHref('/stops', locale)}>{say.browseStops}</a>
				</p>
			</div>
		</div>
	{:else}
		<div class="search-results">
			{#if noMatch}
				<div class="search-none">
					<p class="search-none-title">{say.noResult(text)}</p>
					<p class="search-browse">
						<a href={localizeHref('/lines', locale)}>{say.browseLines}</a>
						<a href={localizeHref('/stops', locale)}>{say.browseStops}</a>
					</p>
				</div>
			{/if}
			{#each shownGroups.filter((group) => group.kind === 'route' || group.kind === 'stop') as group (group.kind)}
				{@render groupSection(group)}
			{/each}
			<!-- Present for every query, so each outcome of the lookup is announced. -->
			<p class="sr-only" role="status">{addressStatus}</p>
			{#if addressRow}
				<!-- The row stays where it is and says the outcome, so focus never drops (#1060 E18). -->
				<div class="search-address">
					<button
						type="button"
						class="search-group-more"
						aria-describedby={addressRow === 'ask' ? `${uid}-notice` : undefined}
						aria-disabled={addressRow === 'ask' ? undefined : 'true'}
						onclick={askAddresses}
						>{addressRow === 'ask' ? say.askAddresses(text) : addressStatus}</button
					>
					{#if addressRow === 'ask'}
						<p class="search-group-note" id="{uid}-notice">{say.addressNotice}</p>
					{/if}
				</div>
			{/if}
			{#if addresses.length > 0}
				<section class="search-group" aria-labelledby="{uid}-address" bind:this={addressSection}>
					<div class="search-group-head">
						<h2 class="search-group-label" id="{uid}-address">
							{say.heading('address', addresses.length)}
						</h2>
					</div>
					<EntityList grid cards interactive items={addresses} key={(hit) => hit.id}>
						{#snippet row(hit)}
							<TransitEntityRow href={addressHref(hit)} title={hit.label} />
						{/snippet}
					</EntityList>
				</section>
			{/if}
			{#each shownGroups.filter((group) => group.kind === 'page' || group.kind === 'vehicle') as group (group.kind)}
				{@render groupSection(group)}
			{/each}
		</div>
	{/if}
</Surface>

<style>
	.search-census {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
		margin-top: 1rem;
		padding-top: 1rem;
		border-top: 1px solid var(--border);
		width: 100%;
	}
	.search-census__examples {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
	}
	.search-census__examples-label {
		font-family: var(--font-mono);
		font-size: var(--text-micro);
		letter-spacing: var(--tracking-eyebrow);
		text-transform: uppercase;
		color: var(--muted-foreground);
	}
	.search-census__chips {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 0.5rem;
	}
	.search-census__chip {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0.375rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: var(--muted);
		color: var(--foreground);
		font-size: var(--text-caption);
		cursor: pointer;
		transition:
			border-color var(--duration-fast) var(--ease-default),
			color var(--duration-fast) var(--ease-default);
	}
	.search-census__chip:hover,
	.search-census__chip:focus-visible {
		border-color: var(--primary);
		color: var(--primary);
	}
	.search-census__chip:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}
	.search-idle {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		text-align: center;
		padding: clamp(1.5rem, 4vw, 2.5rem) 1rem;
		background-color: var(--card);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-card);
	}
	.search-idle-glyph {
		font-family: var(--font-mono);
		font-size: var(--text-heading);
		line-height: 1;
		color: var(--accent-text);
	}
	.search-idle-title,
	.search-none-title {
		font-family: var(--font-heading);
		font-weight: 700;
		font-size: var(--text-subheading);
		color: var(--foreground);
	}
	.search-idle-body {
		color: var(--muted-foreground);
		font-size: var(--text-small);
		line-height: 1.5;
		max-width: var(--measure-notice);
	}
	.search-browse {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1.25rem;
		margin: 0;
		font-size: var(--text-small);
	}
	.search-browse a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
	}

	.search-results {
		display: flex;
		flex-direction: column;
		gap: 2rem;
	}
	.search-none {
		display: grid;
		gap: 0.5rem;
	}
	.search-group,
	.search-address {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 0;
	}
	.search-group-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		/* Help triggers are 44px targets on a 1.05rem footprint: 0.75rem keeps neighbours 24px apart. */
		gap: 0.75rem;
		padding-bottom: 0.25rem;
		border-bottom: 1px solid var(--border);
	}
	.search-group-label {
		margin: 0;
		font-family: var(--font-heading);
		font-weight: 700;
		font-size: var(--text-subheading);
		color: var(--foreground);
		font-variant-numeric: tabular-nums;
	}
	.search-group-note,
	.search-group-shown {
		margin: 0;
		color: var(--muted-foreground);
		font-size: var(--text-small);
		line-height: 1.5;
		max-width: var(--measure-notice);
	}
	.search-group-foot {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 1rem;
	}
	.search-group-more {
		align-self: flex-start;
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0.375rem 0.875rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: transparent;
		color: var(--foreground);
		font-size: var(--text-small);
		text-align: start;
		cursor: pointer;
		transition: border-color var(--duration-fast) var(--ease-default);
	}
	.search-group-more:hover {
		border-color: var(--primary);
	}
	.search-group-more:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}
	@media (prefers-reduced-motion: reduce) {
		.search-census__chip,
		.search-group-more {
			transition: none;
		}
	}
</style>
