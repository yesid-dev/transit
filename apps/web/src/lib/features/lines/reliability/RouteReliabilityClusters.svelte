<script lang="ts">
	import { cn } from '#lib/utils/index.ts';
	import { formatDateKey } from '#lib/utils/time.ts';
	import { selectDailyPercentiles } from '#lib/site/dailyPercentiles.ts';
	import { createReliabilityViewState } from '#lib/reliability/viewState.svelte.ts';
	import { selectVerdictWindow } from '#lib/v1/verdict.ts';
	import { prefersReducedMotion } from '@yesid/motion/stores/reducedMotion';
	import type { Locale } from '#lib/i18n/index.ts';
	import { absenceSentence, describeAbsence } from '#lib/site/absence.ts';
	import type { RouteReliability } from '#lib/v1/index.ts';
	import type { Snippet } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import {
		ArticleControlStack,
		GrainPicker,
		HistoryNavigator,
	} from '#lib/components/surface/index.ts';
	import { ArticleSectionStack, ReliabilityRailLayout } from '#lib/components/layout/index.ts';
	import { type SurfaceRailContext } from '@yesid/ui/layout';
	import { CollapsibleSection, useSectionJump, TocNav, type TocEntry } from '@yesid/ui/brand';
	import { Button } from '@yesid/ui/button';
	import { StateNotice } from '@yesid/ui/feedback';
	import { toReliabilityClusters } from './clusters';
	import { retainedDelayHeadline } from '#lib/v1/verdict.ts';
	import { routeClosedThrough, trailingRouteWindow } from '#lib/v1/closedWindow.ts';
	import { reliabilityCopy } from './reliability.copy';
	import { applyRetainedLineHistory, clearRetainedLineHistory } from './data/retainedHistory';
	import type { LineHistoryResource } from './data/lineHistoryResource.svelte';
	import Section0Verdict from './sections/Section0Verdict.svelte';
	import { selectLineRecord, sharedPublication, type RecordCitation } from './selectors/lineRecord';
	import { selectDailyOnTime } from './selectors/punctualityTrend';
	import Section1WhenToRide from './sections/Section1WhenToRide.svelte';
	import Section2TheWait from './sections/Section2TheWait.svelte';
	import Section3RunAndFit from './sections/Section3RunAndFit.svelte';
	import Section4WorstStops from './sections/Section4WorstStops.svelte';
	import SectionCrowding from './sections/SectionCrowding.svelte';
	import { cutScope } from './selectors/evidence';
	import { formatRecordDates } from './recordDates';

	interface RouteReliabilityClustersProps {
		data: RouteReliability;
		locale: Locale;
		/** Accepted for the pane contract; the gaps name periods of the day, not directions. */
		directionHeadsigns?: Record<number, string>;
		class?: string;
		history?: LineHistoryResource;
		articleSummary?: Snippet;
		/** The line and provider a copied link or citation names. */
		citation?: RecordCitation;
	}

	let {
		data,
		locale,

		class: className,
		history,
		articleSummary,
		citation,
	}: RouteReliabilityClustersProps = $props();

	const copy = $derived(reliabilityCopy[locale]);
	// Short names only: the chosen period's exact dates follow once, in words, below the choices.
	const windowLabels = $derived({
		day: copy.controls.latestDay,
		week: copy.controls.thisWeek,
		month: copy.controls.thisMonth,
		range: copy.controls.dateRange,
	});

	const view = createReliabilityViewState({
		snapshot: () => data,
		retained: {
			resource: () => history,
			copy: () => ({ ...copy.history, noData: absenceSentence('no-retained-data', locale) }),
		},
		grains: {
			keys: ['week', 'day', 'month', 'range'] as const,
			labels: () => windowLabels,
			present: () =>
				new Set(
					(['day', 'week', 'month'] as const).filter((grain) =>
						grain === 'day'
							? routeClosedThrough(data) != null
							: trailingRouteWindow(data, grain) != null,
					),
				),
		},
		apply: (current, retained) =>
			retained ? applyRetainedLineHistory(current, retained) : clearRetainedLineHistory(current),
		locale: () => locale,
		verdict: {
			kind: 'route',
			file: (data) => data,
			headline: (retained) => retainedDelayHeadline(retained.aggregate.delay.value),
		},
	});
	const mode = $derived(view.grain);
	const rangeWindow = $derived(view.navigator?.value);
	const normalizedRange = $derived(
		mode === 'range' && rangeWindow ? { start: rangeWindow.from, end: rangeWindow.to } : undefined,
	);
	const explicitHistory = $derived(view.history.active);
	const retainedReady = $derived(view.history.ready);
	const historyAnnouncement = $derived(view.announcements.correction);
	const historyLiveAnnouncement = $derived(view.announcements.live);
	const selectedData = $derived(view.data);
	const mapperOpts = $derived(
		mode === 'range'
			? {
					grain: 'day',
					dateRange: normalizedRange,
					...(retainedReady && view.history.value != null ? { retained: view.history.value } : {}),
				}
			: { grain: mode },
	);

	const clusters = $derived(
		toReliabilityClusters(selectedData, { ...mapperOpts, verdict: view.verdict }),
	);
	const record = $derived(
		selectLineRecord({
			data: selectedData,
			verdict: view.verdict,
			mode,
			range: normalizedRange ? { from: normalizedRange.start, to: normalizedRange.end } : null,
		}),
	);
	// Day by day covers the record's own days; the latest day is shown with the 13 days before it.
	const dailyWindow = $derived.by(() => {
		const period = record.period;
		if (!period || mode !== 'day') return period;
		const to = Date.parse(`${period.to}T00:00:00Z`);
		return { from: new Date(to - 13 * 86_400_000).toISOString().slice(0, 10), to: period.to };
	});
	const daily = $derived(selectDailyOnTime(clusters.punctuality.trend, dailyWindow));
	// A chosen range cites its retained partitions; anything else cites the line file shown.
	const publication = $derived(
		explicitHistory && retainedReady && view.history.value
			? view.history.value.publication
			: sharedPublication([data]),
	);
	const dailyPercentiles = $derived(
		explicitHistory && retainedReady && mode === 'range'
			? selectDailyPercentiles(view.history.value?.aggregate ?? null)
			: null,
	);

	// Each evidence cut names its own days; a chosen range never borrows the latest day's cut.
	const closedThrough = $derived(routeClosedThrough(selectedData));
	const cutDate = (rows: readonly { grain: string; date?: string | null }[] | null | undefined) =>
		rows?.find((row) => row.grain === (mode === 'range' ? 'day' : mode))?.date ?? null;
	const timeScope = $derived(
		cutScope({
			mode,
			date: cutDate(selectedData.periods_by_grain),
			closedThrough,
			windowed: clusters.punctuality.windowed,
			// Every cut of the same publication row shares its days: periods, day types, weekdays.
			hasRows:
				clusters.punctuality.peakOffPeak.byShift.length +
					clusters.punctuality.peakOffPeak.byDayType.length +
					clusters.punctuality.dayOfWeek.length +
					clusters.punctuality.byShiftDaytype.length >
				0,
		}),
	);
	const stopScope = $derived(
		cutScope({
			mode,
			date: cutDate(selectedData.weak_stops_by_grain),
			closedThrough,
			windowed: clusters.punctuality.weakStopsWindowed,
			hasRows: clusters.punctuality.weakStops.length > 0,
		}),
	);
	const gapScope = $derived(
		cutScope({
			mode,
			date: cutDate(selectedData.headway_by_grain),
			closedThrough,
			windowed: clusters.waitRegularity.windowed,
			hasRows: !clusters.waitRegularity.isEmpty,
		}),
	);

	const retainedDataAbsence = $derived(describeAbsence('no-retained-data', locale));

	const activeWindowCaption = $derived.by<string>(() => {
		const aw = copy.controls.activeWindow;
		if (mode === 'range') {
			if (!normalizedRange) return aw.rangePrompt;
			if (normalizedRange.start === normalizedRange.end) return aw.singleDay(normalizedRange.start);
			const agg = clusters.strip.rangeAggregate;
			if (agg && agg.days > 0) return aw.range(agg.days, agg.start, agg.end);
			return aw.rangeSelection(normalizedRange.start, normalizedRange.end);
		}
		if (mode === 'week' || mode === 'month') {
			const window = trailingRouteWindow(selectedData, mode)?.window;
			return window
				? aw.rangeSelection(formatDateKey(window.from, locale), formatDateKey(window.to, locale))
				: aw.unavailable;
		}
		const latest = selectVerdictWindow(
			selectedData.periods ?? [],
			'day',
			undefined,
			routeClosedThrough(selectedData),
		);
		return aw.day(latest?.grain === 'day' ? (latest.date ?? null) : null);
	});

	const controlsSummary = $derived(
		mode === 'range'
			? copy.controls.dateRange
			: mode === 'week'
				? copy.controls.thisWeek
				: mode === 'month'
					? copy.controls.thisMonth
					: copy.controls.latestDay,
	);
	// A grain's crowding mix names its grain (the file publishes no dates for it); a chosen
	// range's mix is that range's retained days.
	const crowdingScope = $derived(
		mode !== 'range'
			? controlsSummary
			: record.period
				? formatRecordDates(record.period.from, record.period.to, locale)
				: null,
	);

	const sectionNav = $derived([
		{ id: 'rel-verdict', label: copy.sections.verdict.label },
		{ id: 'rel-when-to-ride', label: copy.sections.whenToRide.label },
		{ id: 'rel-worst-stops', label: copy.sections.worstStops.label },
		{ id: 'rel-run-and-fit', label: copy.sections.runAndFit.label },
		{ id: 'rel-the-wait', label: copy.sections.theWait.label },
		{ id: 'rel-crowding', label: copy.sections.crowding.label },
	]);

	const tocEntries: TocEntry[] = $derived(
		sectionNav.map((s, i) => ({
			id: s.id,
			title: s.label,
			level: 2,
			badge: { kind: 'number' as const, value: i + 1 },
			children: [],
		})),
	);

	const navigation = useSectionJump(afterNavigate);
	let sectionRoot = $state<HTMLElement>();
	$effect(() => {
		if (sectionRoot)
			return navigation.register(tocEntries, { root: sectionRoot, landFragments: true });
	});
	const navigate = (id: string) =>
		navigation.jump(id, { behavior: $prefersReducedMotion ? 'auto' : 'smooth' });
</script>

<div
	bind:this={sectionRoot}
	class={cn('reliability-clusters', className)}
	data-slot="reliability-clusters"
>
	<div data-slot="reliability-sections">
		{#snippet rangeControls()}
			{#if mode === 'range'}
				<HistoryNavigator {...view.navigator!} />
			{/if}
		{/snippet}

		{#snippet railContent({ closeSheet }: SurfaceRailContext)}
			{#snippet primaryControls()}
				<GrainPicker
					segments={view.segments}
					value={view.grain}
					onSelect={view.selectGrain}
					label={copy.controls.grainLabel}
					variant="time-grid"
				/>
			{/snippet}
			{#snippet activeWindowCaptionControl()}
				<p class="reliability-window" data-slot="active-window" aria-live="polite">
					{activeWindowCaption}
				</p>
			{/snippet}

			<CollapsibleSection independent title={copy.controls.viewLabel}>
				<ArticleControlStack
					primary={primaryControls}
					secondary={mode === 'range' ? rangeControls : undefined}
					caption={activeWindowCaptionControl}
				/>
			</CollapsibleSection>

			<div class="rail-toc" data-slot="section-toc">
				<TocNav
					entries={tocEntries}
					{navigation}
					onNavigate={(id) => {
						void navigate(id);
						closeSheet();
					}}
					heading={copy.controls.toc}
				/>
			</div>
		{/snippet}

		{#snippet reliabilityContent()}
			<p
				class="reliability-history-announcement sr-only"
				data-slot="history-page-announcement"
				role="status"
				aria-live="polite"
				aria-atomic="true"
			>
				{historyLiveAnnouncement}
			</p>

			<div class="reliability-content">
				{#if historyAnnouncement}
					<p class="reliability-history-correction" data-slot="history-correction">
						{historyAnnouncement}
					</p>
				{/if}
				{#if explicitHistory}
					{#if view.history.state === 'no-data'}
						<StateNotice
							title={retainedDataAbsence.label}
							body={`${retainedDataAbsence.why}. ${copy.history.currentOnly}`}
							presentation="responsive"
							data-slot="history-no-data"
						/>
					{:else}
						<div class="reliability-history-state" data-slot="history-state">
							<div class="reliability-history-status">
								{#if view.history.state === 'loading-index' || view.history.state === 'loading-range'}
									<p data-slot="history-loading">{copy.history.loading}</p>
								{:else if view.history.state === 'partial'}
									<p data-slot="history-partial">{copy.history.partial}</p>
								{:else if view.history.state === 'error'}
									<p data-slot="history-error">{copy.history.error}</p>
									<Button variant="outline" size="sm" onclick={() => view.history.retry()}>
										{copy.history.retry}
									</Button>
								{/if}
							</div>
							<p data-slot="history-current-only">{copy.history.currentOnly}</p>
						</div>
					{/if}
				{/if}
				<ArticleSectionStack>
					<div class="reliability-band" id="rel-verdict" data-toc="rel-verdict" data-band="verdict">
						<Section0Verdict
							vm={clusters.punctuality}
							{record}
							{daily}
							{locale}
							{copy}
							{mode}
							{dailyPercentiles}
							{citation}
							{publication}
						/>
					</div>

					<div
						class="reliability-band"
						id="rel-when-to-ride"
						data-toc="rel-when-to-ride"
						data-band="when-to-ride"
					>
						<Section1WhenToRide
							punctuality={clusters.punctuality}
							habits={clusters.habits}
							scope={timeScope}
							{locale}
							{copy}
						/>
					</div>

					<div
						class="reliability-band"
						id="rel-worst-stops"
						data-toc="rel-worst-stops"
						data-band="worst-stops"
					>
						<Section4WorstStops
							stops={clusters.punctuality.weakStops}
							scope={stopScope}
							{locale}
							{copy}
						/>
					</div>

					<div
						class="reliability-band"
						id="rel-run-and-fit"
						data-toc="rel-run-and-fit"
						data-band="run-and-fit"
					>
						<Section3RunAndFit
							service={clusters.serviceDelivered}
							period={record.period}
							{locale}
							{copy}
							showServiceCompleteness={explicitHistory && retainedReady}
						/>
					</div>

					<div
						class="reliability-band"
						id="rel-the-wait"
						data-toc="rel-the-wait"
						data-band="the-wait"
					>
						<Section2TheWait
							wait={clusters.waitRegularity}
							serviceSpans={clusters.serviceDelivered.serviceSpans}
							scope={gapScope}
							{locale}
							{copy}
						/>
					</div>

					<div
						class="reliability-band"
						id="rel-crowding"
						data-toc="rel-crowding"
						data-band="crowding"
					>
						<SectionCrowding crowding={clusters.crowding} scope={crowdingScope} {locale} {copy} />
					</div>
				</ArticleSectionStack>
			</div>
		{/snippet}

		<ReliabilityRailLayout
			rail={railContent}
			content={reliabilityContent}
			{articleSummary}
			label={copy.controls.viewLabel}
			summary={controlsSummary}
			openAria={copy.controls.filterPillOpen}
			closeAria={copy.controls.filterPillClose}
		/>
	</div>
</div>

<style>
	.reliability-clusters {
		display: flex;
		flex-direction: column;
		width: 100%;
	}

	.reliability-content {
		display: flex;
		flex-direction: column;
		gap: var(--space-card-gap);
		min-width: 0;
	}

	.reliability-window {
		margin: 0;
		flex-basis: 100%;
		font-family: var(--font-mono);
		font-size: var(--text-caption);
		line-height: 1.3;
		color: var(--muted-foreground);
	}
	.reliability-history-state {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		padding: 0.75rem 1rem;
		font-family: var(--font-mono);
		font-size: var(--text-small);
		line-height: 1.4;
		color: var(--muted-foreground);
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
	}
	.reliability-history-state p {
		margin: 0;
	}
	.reliability-history-status {
		min-block-size: 1lh;
	}
	.reliability-history-correction {
		margin: 0;
		padding: 0.75rem 1rem;
		font-family: var(--font-mono);
		font-size: var(--text-small);
		line-height: 1.4;
		color: var(--foreground);
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
	}

	.reliability-clusters :global([data-surface-controls] [data-slot='controls-nav']) {
		justify-content: space-between;
	}
	.reliability-band {
		min-width: 0;
	}
	/* Below desktop the view pill takes its own lane above the record instead of floating over it,
	   so it never covers the first heading. Its sheet still opens from the bottom of the screen. */
	@media (--desktop-max) {
		.reliability-clusters :global([data-slot='surface-rail-mobile']) {
			position: static;
			transform: none;
		}
		.reliability-clusters :global([data-slot='surface-rail-mobile'] > button) {
			max-width: 100%;
		}
	}
	/* The line's window choices carry their dates; each wraps inside its grid cell instead of
	   running past the picker's clipped edge in the rail. */
	.reliability-clusters
		:global([data-slot='grain-picker'][data-variant='time-grid'] [role='radio']) {
		white-space: normal;
		text-wrap: balance;
	}
	@media (prefers-reduced-motion: no-preference) {
		:global([data-slot='reliability-rail-layout']) {
			scroll-behavior: smooth;
		}
	}
	:global(.reliability-band [data-card]) {
		border: 1px solid var(--border);
		background: var(--surface-2);
		border-radius: var(--radius-lg);
		padding: clamp(0.9rem, 2.2vw, 1.35rem);
	}
	:global(.reliability-band [data-card='primary']) {
		border-color: var(--border-rule);
	}
	:global(.reliability-band [data-card] [data-slot='section-label']) {
		color: var(--accent-text);
		font-weight: 600;
	}
</style>
