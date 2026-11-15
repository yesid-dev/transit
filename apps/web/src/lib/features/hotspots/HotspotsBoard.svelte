<script lang="ts">
	import type { Manifest } from '#lib/v1/schemas/index.ts';
	import { createRecordStamp } from '#lib/v1/recordStamp.svelte.ts';
	import ArticleHeader from '#lib/components/layout/TransitArticleHeader.svelte';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { createReliabilityViewState } from '#lib/reliability/viewState.svelte.ts';
	import { onDestroy } from 'svelte';
	import { page } from '$app/state';
	import { getLocale, getLocalizeHref, intl, type Locale } from '#lib/i18n/index.ts';
	import { transitTerms } from '#lib/i18n/transitTerms.copy.ts';
	import { routeFor } from '#lib/nav/index.ts';
	import { metricInfoCopy, metricInfoFor } from '#lib/metrics.ts';
	import {
		fromSearchParams,
		toSearchParams,
		emptyFilterState,
		type WorstN,
	} from '#lib/filters/index.ts';
	import { availabilityFromPointCollectionIndex } from '#lib/v1/history/selection.ts';
	import { createHistoryCorrectionPresentation } from '#lib/v1/history/datePresentation.svelte.ts';
	import {
		createHistoryDateResource,
		historyDateRequestFromSearchParams,
	} from '#lib/v1/history/dateResource.svelte.ts';
	import {
		getHotspots,
		getHotspotsHistoryDay,
		getHotspotsHistoryIndex,
	} from '#lib/v1/repositories/historic.ts';
	import type { HistoricCollectionIndex, Hotspots } from '#lib/v1/schemas/index.ts';
	import {
		HistoryNavigator,
		ResourceBoundary,
		GrainPicker,
		type GrainSegment,
	} from '#lib/components/surface/index.ts';
	import type { ArticleMetaEntry } from '#lib/components/layout/index.ts';
	import { DetailFrame } from '@yesid/ui/layout';
	import { CollapsibleSection } from '@yesid/ui/brand';
	import SectionsToggle from '#lib/components/shared/SectionsToggle.svelte';
	import { fmtLocalePct } from '#lib/utils/format.ts';
	import { formatDateKey } from '#lib/utils/time.ts';
	import { ladderGrains } from '#lib/reliability/ladderGrains.ts';
	import { worstNCap, DEFAULT_WORST_N } from '#lib/reliability/ladderCap.ts';
	import {
		formatDayRange,
		readHotspotRanking,
		type RankedRow,
		type RankingKind,
	} from './selectors/hotspotRanking';
	import HotspotSection, { type HotspotRowView } from './sections/HotspotSection.svelte';
	import HotspotEvidence from './sections/HotspotEvidence.svelte';
	import { copy as COPY } from './hotspots.copy';

	/** The approved periods: 7 complete days by default, 30 as the alternative. */
	const PERIODS = ['week', 'month'] as const;
	type Period = (typeof PERIODS)[number];

	let { manifest = null }: { manifest?: Manifest | null } = $props();
	const display = transitDisplay();
	const localizeHref = getLocalizeHref();
	const locale: Locale = getLocale();
	const t = $derived(COPY[locale]);
	const terms = $derived(transitTerms[locale]);
	const count = (n: number) => intl.number(locale).format(n);

	const hotspots = createHistoryDateResource<HistoricCollectionIndex, Hotspots>(
		{
			loadIndex: (signal) => getHotspotsHistoryIndex({ signal }),
			availability: (index) => availabilityFromPointCollectionIndex(index),
			loadCurrent: (signal) => getHotspots({ signal }),
			loadDate: (date, index, signal) => getHotspotsHistoryDay(date, index, { signal }),
		},
		{
			initialRequest: historyDateRequestFromSearchParams(new URLSearchParams(page.url.search)),
		},
	);
	onDestroy(() => hotspots.destroy());

	const initial = new URLSearchParams(page.url.search);
	let kind = $state<RankingKind>(initial.get('kind') === 'stops' ? 'stop' : 'route');
	let selectedId = $state<string | null>(initial.get('selected'));
	let expanded = $state(initial.has('selected'));
	let worstN = $state<WorstN>(fromSearchParams(initial).worstN ?? DEFAULT_WORST_N);

	const availableDates = $derived(hotspots.availableDates);
	const hasHistoryNavigator = $derived(availableDates.length > 0);
	// The ranking waits for history discovery, so its controls never push the rows down later.
	const discovered = $derived(hotspots.resolved !== null || hotspots.error != null);
	const historyCorrection = createHistoryCorrectionPresentation(
		hotspots,
		() => t.history.correction,
	);
	function selectHistoryDate(date: string | undefined): void {
		historyCorrection.clear();
		hotspots.setRequest({ hasDate: date !== undefined, rawDate: date ?? null });
	}
	const requestedDate = $derived(
		hotspots.request.hasDate && hotspots.resolved == null
			? hotspots.request.rawDate
			: hotspots.canonicalDate,
	);

	const grains = $derived(ladderGrains(hotspots.data?.by_grain, PERIODS));
	const view = createReliabilityViewState({
		snapshot: () => hotspots.data,
		grains: {
			keys: PERIODS,
			labels: () => ({ week: t.period.week, month: t.period.month }),
			present: () => grains.present,
		},
		locale: () => locale,
		url: () => {
			const state = emptyFilterState();
			if (worstN !== DEFAULT_WORST_N) state.worstN = worstN;
			return {
				date: requestedDate,
				n: toSearchParams(state).get('n'),
				kind: kind === 'stop' ? 'stops' : null,
				selected: selectedId,
			};
		},
	});
	const period = $derived<Period>(view.grain);
	const ranking = $derived(readHotspotRanking(grains.ladders.get(period), kind));
	const dates = $derived(ranking.state === 'absent' ? null : ranking.period);
	const range = $derived(dates ? formatDayRange(dates.from, dates.to, locale) : null);
	const periodText = $derived(
		dates && range
			? t.period.line(range, terms.completeDays(dates.days, count(dates.days)))
			: t.period.unknown,
	);
	const recordSearch = $derived(dates ? `from=${dates.from}&to=${dates.to}` : undefined);
	const recordHref = (id: string, of: RankingKind = kind) =>
		localizeHref(
			routeFor({ kind: of === 'route' ? 'line' : 'stop', id, search: recordSearch }),
			locale,
		);

	function identityOf(id: string, published: string | null) {
		if (kind === 'stop') return { number: null, name: published ?? id };
		const line = display.lineName(id, published);
		const number = line.number ?? (line.name ? null : id);
		return { number, name: line.name && line.name !== number ? line.name : null };
	}
	function rowView(row: RankedRow, eligible: number | null): HotspotRowView {
		const { number, name } = identityOf(row.id, row.name);
		const identity = [number, name].filter(Boolean).join(', ');
		return {
			key: row.key,
			id: row.id,
			position: row.position,
			positionText: t.ranking.position(
				count(row.position),
				eligible == null ? null : count(eligible),
			),
			number,
			name,
			kindWord: t.kindWord[kind],
			identity,
			spoken: `${t.kindWord[kind]} ${identity}`,
			share: fmtLocalePct(row.latePct, locale),
			readingsText:
				row.readings == null ? t.readingsUnknown : t.readings(row.readings, count(row.readings)),
			href: recordHref(row.id),
			stopId: kind === 'stop' ? row.id : null,
		};
	}
	const rows = $derived(
		ranking.state === 'ranked' ? ranking.rows.map((row) => rowView(row, ranking.eligible)) : [],
	);
	const shownRows = $derived(rows.slice(0, worstNCap(worstN)));
	const selected = $derived(shownRows.find((row) => row.id === selectedId) ?? shownRows[0] ?? null);
	const defaultCap = worstNCap(DEFAULT_WORST_N);
	const toggle = $derived.by(() => {
		if (shownRows.length < rows.length)
			return {
				label: t.ranking.showAll(kind, count(rows.length)),
				onclick: () => (worstN = 'all'),
			};
		if (worstN !== DEFAULT_WORST_N && rows.length > defaultCap)
			return {
				label: t.ranking.showFewer(kind, count(defaultCap)),
				onclick: () => (worstN = DEFAULT_WORST_N),
			};
		return null;
	});
	const countText = $derived(
		ranking.state === 'ranked'
			? t.ranking.count(
					kind,
					[shownRows.length, count(shownRows.length)],
					[ranking.published, count(ranking.published)],
					ranking.eligible == null ? null : [ranking.eligible, count(ranking.eligible)],
				)
			: '',
	);
	const finding = $derived.by(() => {
		if (ranking.state === 'absent') return t.finding.absent[period];
		if (ranking.state === 'invalid') return t.finding.invalid;
		if (ranking.state === 'none') return t.finding.none[kind];
		return t.finding[kind](rows[0].identity);
	});

	const belowFloor = $derived(ranking.state === 'absent' ? null : ranking.belowFloor);
	const excludedSummary = $derived.by(() => {
		if (belowFloor == null) return '';
		const { count: total, examples } = belowFloor;
		if (examples.length > 0)
			return total == null
				? t.excluded.examples(examples.length, count(examples.length))
				: t.excluded.complete(kind, total, count(total));
		return total === 0 ? t.excluded.zero[kind] : t.excluded.unknown[kind];
	});

	const methodVersion = $derived(hotspots.data?.methodology_version?.trim() || null);
	const methodText = $derived(
		methodVersion ? t.evidence.method(methodVersion) : t.evidence.methodUnknown,
	);
	const generatedUtc = $derived(hotspots.data?.generated_utc ?? null);
	const publishedOn = $derived(generatedUtc?.slice(0, 10) ?? null);
	const sentence = (text: string) =>
		locale === 'fr' ? text.charAt(0).toLowerCase() + text.slice(1) : text;

	/**
	 * A copied link reopens this record, not whichever one is latest then: it names the shown
	 * record's date (its period ends there) and the row cap that keeps the chosen row visible.
	 * The browsing URL keeps its own cleanup of the latest date.
	 */
	function sameViewUrl(row: HotspotRowView): string {
		const date = hotspots.canonicalDate ?? dates?.to ?? null;
		const query = [
			kind === 'stop' ? 'kind=stops' : null,
			period === PERIODS[0] ? null : `grain=${period}`,
			date ? `date=${date}` : null,
			worstN === DEFAULT_WORST_N ? null : `n=${worstN}`,
			`selected=${encodeURIComponent(row.id)}`,
		]
			.filter((part) => part != null)
			.join('&');
		return new URL(localizeHref(`/hotspots?${query}`, locale), page.url.origin).href;
	}
	function citation(row: HotspotRowView): string {
		return t.citation({
			provider: manifest?.display_name?.trim() || null,
			subject: row.spoken,
			share: row.share,
			period: range ? sentence(range) : null,
			readings: row.readingsText,
			published:
				publishedOn && /^\d{4}-\d{2}-\d{2}$/.test(publishedOn)
					? sentence(formatDayRange(publishedOn, publishedOn, locale))
					: null,
			method: methodText,
			url: sameViewUrl(row),
		});
	}

	function selectRow(key: string): void {
		const row = shownRows.find((candidate) => candidate.key === key);
		if (!row) return;
		if (!wide && row.key === selected?.key && expanded) {
			expanded = false;
			return;
		}
		selectedId = row.id;
		expanded = true;
	}
	function selectKind(next: RankingKind): void {
		if (next === kind) return;
		kind = next;
		selectedId = null;
		expanded = false;
	}
	function selectPeriod(next: string): void {
		if (next === view.grain) return;
		view.selectGrain(next);
		selectedId = null;
		expanded = false;
	}
	const kindSegments = $derived<GrainSegment<RankingKind>[]>([
		{ key: 'route', label: t.kind.route },
		{ key: 'stop', label: t.kind.stop },
	]);

	const paneId = $props.id();
	let frameWidth = $state(0);
	// The container query below shows the side pane at 60rem; the buttons follow the same rule.
	const wide = $derived(
		frameWidth > 0 &&
			frameWidth >= 60 * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16),
	);

	const record = createRecordStamp(
		() => manifest,
		() => generatedUtc,
	);
	const articleMeta = $derived.by((): readonly ArticleMetaEntry[] => {
		const stamp = record.meta(locale);
		return stamp ? [stamp] : [];
	});
	const metricHref = $derived(
		`${localizeHref('/metrics', locale)}#${metricInfoFor('severe', locale).anchor}`,
	);
</script>

{#snippet historyControls()}
	{#key historyCorrection.revision}
		<HistoryNavigator
			mode="date"
			date={hotspots.selectedDate ?? undefined}
			dateOptions={availableDates.map((date) => ({ date }))}
			previousDate={hotspots.previousDate}
			nextDate={hotspots.nextDate}
			coverageText={availableDates.length === 0
				? null
				: t.history.coverage(
						formatDateKey(availableDates[0], locale),
						formatDateKey(availableDates[availableDates.length - 1], locale),
					)}
			selectionText={hotspots.selectedDate == null
				? null
				: t.history.selection(formatDateKey(hotspots.selectedDate, locale))}
			announcement={historyCorrection.announcement}
			liveAnnouncement={false}
			{locale}
			labels={t.history.navigator}
			onDateChange={selectHistoryDate}
		/>
	{/key}
{/snippet}

{#snippet evidence(row: HotspotRowView, level: 2 | 3)}
	<HotspotEvidence
		{row}
		{level}
		period={periodText}
		method={methodText}
		link={sameViewUrl(row)}
		citation={citation(row)}
		copy={t}
		{locale}
	/>
{/snippet}
{#snippet inlineEvidence(row: HotspotRowView)}
	{@render evidence(row, 3)}
{/snippet}

<DetailFrame class="hotspots-detail">
	{#snippet header()}
		<ArticleHeader
			watermark={t.article.watermark}
			category={t.kicker}
			title={t.heading}
			highlight={t.article.tags[0]}
			backHref={localizeHref('/', locale)}
			backLabel={t.article.back}
			meta={articleMeta}
			metaPending={hotspots.loading || !hotspots.settled || record.pending}
			titleId="hotspots-title"
		>
			{#snippet controls()}
				<SectionsToggle />
			{/snippet}
		</ArticleHeader>
	{/snippet}

	<p
		class="hotspots-history-live sr-only"
		data-slot="history-page-announcement"
		role="status"
		aria-live="polite"
		aria-atomic="true"
	>
		{historyCorrection.announcement ?? ''}
	</p>
	<div class="hotspots-page" data-slot="hotspots-page">
		<p class="hotspots-purpose">{t.purpose}</p>
		<!-- Controls stay usable while a record loads; the ranking below waits for history discovery. -->
		<section class="hotspots-controls" aria-label={t.controls} data-slot="hotspots-controls">
			<div class="hotspots-pickers">
				<GrainPicker
					segments={kindSegments}
					value={kind}
					onSelect={(key) => selectKind(key as RankingKind)}
					label={t.kind.label}
				/>
				<GrainPicker
					segments={view.segments}
					value={view.grain}
					onSelect={selectPeriod}
					label={t.period.label}
				/>
			</div>
			{#if hasHistoryNavigator}{@render historyControls()}{/if}
		</section>
		<ResourceBoundary resource={hotspots} lang={locale}>
			{#if discovered}
				<div class="hotspots-controls">
					<p class="hotspots-period" data-slot="hotspots-period">{periodText}</p>
					<p class="hotspots-measure">{t.measure}</p>
				</div>

				<h2 class="hotspots-finding" data-slot="hotspots-finding">{finding}</h2>

				{#if ranking.state === 'ranked' && selected}
					<div class="hotspots-workspace-frame" bind:clientWidth={frameWidth}>
						<div class="hotspots-workspace">
							<HotspotSection
								heading={t.ranking.heading[kind]}
								count={countText}
								rows={shownRows}
								selected={selected.key}
								{wide}
								{expanded}
								{paneId}
								onSelect={selectRow}
								{toggle}
								evidence={inlineEvidence}
								copy={t}
							/>
							<aside
								id={paneId}
								class="hotspots-evidence-pane"
								aria-label={t.evidence.heading}
								data-slot="hotspot-evidence-pane"
							>
								{@render evidence(selected, 2)}
							</aside>
						</div>
					</div>
				{/if}

				{#if belowFloor}
					<section
						class="hotspots-exclusions"
						aria-labelledby="hotspots-exclusions-heading"
						data-slot="hotspot-exclusions"
					>
						<h2 id="hotspots-exclusions-heading" class="hotspots-section-heading">
							{t.exclusions.heading[kind]}
						</h2>
						<ul class="hotspots-exclusion-rows">
							<li>
								<span>{t.exclusions.floor}</span>
								<span class="hotspots-exclusion-total" data-slot="hotspot-floor-total">
									{belowFloor.count == null
										? t.exclusions.unknown
										: t.exclusions.total(kind, belowFloor.count, count(belowFloor.count))}
								</span>
							</li>
							{#if kind === 'route'}
								<li>
									<span>{t.exclusions.noLive}</span>
									<span class="hotspots-exclusion-total">{t.exclusions.unknown}</span>
								</li>
							{/if}
						</ul>
						{#if kind === 'route'}
							<p class="hotspots-meta">{t.exclusions.noLiveLimit}</p>
						{/if}
						{#if belowFloor.examples.length === 0}
							<p class="hotspots-meta" data-slot="hotspot-excluded-summary">{excludedSummary}</p>
						{/if}
					</section>

					{#if belowFloor.examples.length > 0}
						<CollapsibleSection title={t.excluded.title} anchor="hotspots-excluded">
							{#snippet summary()}
								<p class="hotspots-meta" data-slot="hotspot-excluded-summary">{excludedSummary}</p>
							{/snippet}
							<ul class="hotspots-excluded" aria-label={t.excluded.label[kind]}>
								{#each belowFloor.examples as example (example.key)}
									{@const identity = identityOf(example.id, example.name)}
									{@const named = [identity.number, identity.name].filter(Boolean).join(', ')}
									<li>
										<a href={recordHref(example.id)} aria-label="{t.kindWord[kind]} {named}"
											>{named}</a
										>
										<span class="hotspots-excluded-readings">
											{example.readings == null
												? t.readingsUnknown
												: t.readings(example.readings, count(example.readings))}
										</span>
										<span class="hotspots-meta">{t.exclusions.floor}</span>
									</li>
								{/each}
							</ul>
						</CollapsibleSection>
					{/if}
				{/if}

				<CollapsibleSection title={t.method.title} anchor="hotspots-method">
					{#snippet summary()}
						<p class="hotspots-meta">{t.method.summary}</p>
					{/snippet}
					<div class="hotspots-method">
						<p>{t.method.engine}</p>
						<p>{t.method.definition}</p>
						<p>{t.method.bounds}</p>
						<p>{methodText}</p>
						<a href={metricHref}>{metricInfoCopy[locale].link}</a>
					</div>
				</CollapsibleSection>
			{/if}
		</ResourceBoundary>
	</div>
</DetailFrame>

<style>
	/* Room for the ranking and its selected evidence side by side on desktop. */
	:global([data-slot='detail-shell'].hotspots-detail) {
		--detail-center-max: var(--container-wide);
	}
	.hotspots-page {
		display: grid;
		gap: 1.5rem;
		min-width: 0;
	}
	.hotspots-page :global(p) {
		margin: 0;
	}
	.hotspots-purpose {
		font-size: var(--text-detail-subheading-mobile);
		line-height: 1.5;
	}
	.hotspots-controls {
		display: grid;
		gap: 0.5rem;
		min-width: 0;
	}
	.hotspots-pickers {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem 1.25rem;
	}
	.hotspots-period {
		font-weight: 600;
	}
	.hotspots-measure,
	.hotspots-meta {
		color: var(--muted-foreground);
		font-size: var(--text-small);
	}
	.hotspots-finding {
		margin: 0;
		font-size: var(--text-heading);
		line-height: 1.3;
		overflow-wrap: anywhere;
	}
	.hotspots-workspace-frame {
		container: hotspots-workspace / inline-size;
		min-width: 0;
	}
	.hotspots-workspace {
		display: grid;
		align-items: start;
		gap: 1.5rem;
	}
	.hotspots-evidence-pane {
		display: none;
		padding: 1rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
	}
	.hotspots-section-heading {
		margin: 0;
		font-size: var(--text-heading);
		line-height: 1.25;
	}
	.hotspots-exclusions {
		display: grid;
		gap: 0.75rem;
		padding-top: 1.25rem;
		border-top: 1px solid var(--border);
	}
	.hotspots-exclusion-rows,
	.hotspots-excluded {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.hotspots-exclusion-rows li {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 0.25rem 1rem;
		padding-block: 0.5rem;
		border-bottom: 1px solid var(--border);
	}
	.hotspots-exclusion-total {
		color: var(--muted-foreground);
	}
	.hotspots-excluded li {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 0.25rem 0.75rem;
		padding-block: 0.625rem;
		border-bottom: 1px solid var(--border);
	}
	.hotspots-excluded a {
		display: inline-flex;
		align-items: center;
		min-height: var(--size-tap-min);
		overflow-wrap: anywhere;
	}
	.hotspots-excluded .hotspots-meta {
		grid-column: 1 / -1;
	}
	.hotspots-excluded-readings {
		align-self: center;
		font-variant-numeric: tabular-nums;
	}
	.hotspots-method {
		display: grid;
		gap: 0.75rem;
	}
	.hotspots-method a {
		display: inline-flex;
		align-items: center;
		justify-self: start;
		min-height: var(--size-tap-min);
	}
	@container hotspots-workspace (min-width: 60rem) {
		.hotspots-workspace {
			grid-template-columns: minmax(0, 7fr) minmax(0, 5fr);
		}
		.hotspots-evidence-pane {
			display: block;
		}
	}
	@media (--desktop-min) {
		.hotspots-purpose {
			font-size: var(--text-detail-subheading-desktop);
		}
	}
</style>
