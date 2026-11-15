<script lang="ts">
	import { getLocalizeHref, intl, type Locale } from '#lib/i18n/index.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { routeFor } from '#lib/nav/index.ts';
	import { fmtDelayMin } from '#lib/utils/index.ts';
	import type { DateWindow } from '#lib/filters/index.ts';
	import { absenceSentence, absenceShort, describeAbsence } from '#lib/site/absence.ts';
	import { availabilityFromCollectionIndex } from '#lib/v1/history/selection.ts';
	import { formatDateKey } from '#lib/utils/time.ts';
	import { prefersReducedMotion } from '@yesid/motion/stores/reducedMotion';
	import type { StopReliability } from '#lib/v1/index.ts';
	import type { OccupancyCode } from '#lib/v1/schemas/index.ts';
	import {
		ArticleControlStack,
		ReliabilityPane,
		GrainPicker,
		HistoryNavigator,
	} from '#lib/components/surface/index.ts';
	import { CollapsibleSection, useSectionJump, TocNav, type TocEntry } from '@yesid/ui/brand';
	import type { Snippet } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import { ArticleSectionStack, ReliabilityRailLayout } from '#lib/components/layout/index.ts';
	import { Button } from '@yesid/ui/button';
	import { StateNotice } from '@yesid/ui/feedback';
	import { VerdictBanner } from '#lib/components/brand/index.ts';
	import { createReliabilityViewState } from '#lib/reliability/viewState.svelte.ts';
	import type { MetricKey, SupplementalMetricKey } from '#lib/metrics.ts';
	import MetricInfo from '#lib/features/metrics/MetricInfo.svelte';
	import { weekdayLabel, shiftLabel, dayTypeLabel } from '#lib/features/reliability/shiftGrains.ts';
	import { detailCopy as linesDetailCopy } from '#lib/features/lines/lines.copy.ts';

	import { type ReliabilityGrain as StopGrain } from '#lib/reliability/grains.ts';
	import { selectDailyPercentiles } from '#lib/site/dailyPercentiles.ts';
	import { applyRetainedStopHistory, clearRetainedStopHistory } from '../data/retainedHistory';
	import type { StopHistoryResource } from '../data/stopHistoryResource.svelte';
	import { selectGradedPeriods, selectDayPercentiles } from '../selectors/gradedPeriods';
	import { selectRankedRoutes } from '../selectors/rankedRoutes';
	import { selectWeekdaySeasonality } from '../selectors/weekdaySeasonality';
	import { selectTimeOfDay } from '../selectors/timeOfDay';
	import { hasHabits } from '#lib/reliability/habitsHeatmap.ts';
	import { selectCrowdingMix } from '../selectors/crowdingMix';
	import { selectDayByDay } from '../selectors/dailyTrend';
	import { dayByDaySummary } from '../selectors/dayByDayText';
	import { stopReliabilityCopy } from '../stops-reliability.copy';

	import SectionPercentiles from './SectionPercentiles.svelte';
	import SectionByRoute from './SectionByRoute.svelte';
	import SectionWeekday from './SectionWeekday.svelte';
	import SectionTimeOfDay from './SectionTimeOfDay.svelte';
	import SectionHabits from './SectionHabits.svelte';
	import SectionCrowding from './SectionCrowding.svelte';
	import SectionDailyTrend from './SectionDailyTrend.svelte';
	import SectionSource from './SectionSource.svelte';

	const display = transitDisplay();

	const localizeHref = getLocalizeHref();

	interface StopReliabilitySurfaceProps {
		data: StopReliability;
		locale: Locale;
		window?: DateWindow | null;
		/** The record answer's seven days; Day by day shows them unless the visitor chose dates. */
		recordWindow?: DateWindow | null;
		history?: StopHistoryResource;
		articleSummary?: Snippet;
		syncUrl?: boolean;
	}
	let {
		data,
		locale,
		window: windowOverride = undefined,
		recordWindow = null,
		history,
		articleSummary,
		syncUrl = true,
	}: StopReliabilitySurfaceProps = $props();

	const copy = $derived(stopReliabilityCopy[locale]);
	const noObservationLabel = $derived(absenceShort('no-observations', locale));
	const retainedDataAbsence = $derived(describeAbsence('no-retained-data', locale));
	const retainedDataBody = $derived(`${retainedDataAbsence.why}. ${copy.history.currentOnly}`);

	const grainLabels = $derived({
		day: copy.grain.day,
		week: copy.grain.week,
		month: copy.grain.month,
	});
	const view = createReliabilityViewState({
		snapshot: () => data,
		retained: {
			resource: () => history,
			copy: () => ({ ...copy.history, noData: absenceSentence('no-retained-data', locale) }),
			window: () => windowOverride,
		},
		grains: { keys: ['week', 'day', 'month'] as const, labels: () => grainLabels },
		apply: (current, retained) =>
			retained ? applyRetainedStopHistory(current, retained) : clearRetainedStopHistory(current),
		locale: () => locale,
		verdict: { file: (data) => data, copy: () => copy.verdict },
		url: () => (syncUrl ? {} : false),
	});
	const grain = $derived<StopGrain>(view.grain);
	const grainSegments = $derived(view.segments);
	const explicitHistory = $derived(view.history.active);
	const retainedReady = $derived(view.history.ready);
	const availableHistoryDates = $derived(view.navigator?.availableDates ?? []);
	const historySelectionText = $derived(view.navigator?.selectionText ?? null);
	const effectiveWindow = $derived(view.window ?? null);
	const historyAnnouncement = $derived(view.announcements.correction);
	const historyLiveAnnouncement = $derived(view.announcements.live);
	const windowCaption = $derived(copy.grain.window(grain));
	const grainSummary = $derived(grainLabels[grain] ?? grain);
	const selectedData = $derived(view.data);
	// A chosen range shows its own days once they load; until then nothing stands in for them.
	// A chosen range shows its own days once they load: until then (or when it fails) its state
	// stands in the section, never the snapshot's days or empty rows.
	const dayByDayHeld = $derived(
		explicitHistory && !retainedReady && view.history.state !== 'no-data'
			? view.history.state === 'error'
				? copy.history.error
				: copy.history.loading
			: null,
	);
	const dayByDay = $derived(
		selectDayByDay(selectedData.daily, {
			chosen: effectiveWindow,
			record: recordWindow,
		}),
	);
	const dayByDayPresent = $derived(dayByDayHeld != null || dayByDay.rows.length > 0);
	const gradedPeriods = $derived(
		selectGradedPeriods(data.periods, grain, (g) => copy.grain[g as StopGrain] ?? g),
	);
	const retainedPercentiles = $derived(
		explicitHistory && retainedReady
			? selectDailyPercentiles(view.history.value?.aggregate ?? null)
			: null,
	);
	const dayPercentiles = $derived(
		explicitHistory ? retainedPercentiles : selectDayPercentiles(data.periods, grain),
	);
	// Habits, weekday and time-of-day pool all retained history; the stop's history index
	// gives its dates. Without that index, no dates are claimed.
	const allHistoryScope = $derived.by(() => {
		const coverage = history?.index ? availabilityFromCollectionIndex(history.index) : null;
		if (coverage?.kind !== 'continuous') return null;
		const date = (key: string) => formatDateKey(key, locale, true);
		return copy.scope.allHistory(date(coverage.firstDate), date(coverage.lastDate));
	});

	const stopVerdict = $derived(view.verdict);

	const fmtMin = (v: number | null): string =>
		fmtDelayMin(v, { rounding: 'fixed1', noData: noObservationLabel });
	const rankedRoutes = $derived(
		selectRankedRoutes(
			data.by_route,
			fmtMin,
			{
				href: (routeId) => localizeHref(routeFor({ kind: 'line', id: routeId }), locale),
			},
			display.directory,
		),
	);

	const rankedWeekdays = $derived(
		selectWeekdaySeasonality(data.day_of_week, {
			severeShare: copy.weekday.severeShare,
			avgDelay: copy.weekday.avgDelay,
			weekdayLabel: (iso) => weekdayLabel(iso, locale),
		}),
	);
	const hasWeekday = $derived(rankedWeekdays.length > 0);

	const timeOfDay = $derived(
		selectTimeOfDay(data.periods, {
			shiftLabel: (g) => shiftLabel(g, locale),
			dayTypeLabel: (g) => dayTypeLabel(g, locale),
		}),
	);

	const habitsMatrix = $derived(data.habits?.matrix ?? []);
	const habitsPresent = $derived(hasHabits(habitsMatrix));

	const occupancyBands = $derived(linesDetailCopy[locale].occupancyBands);
	const crowding = $derived(
		selectCrowdingMix(selectedData.occupancy_mix, (code: OccupancyCode) => occupancyBands[code], {
			title: copy.crowding.barLabel,
			locale,
		}),
	);
	const crowdingSettled = $derived(!explicitHistory || retainedReady);
	const crowdingWindowText = $derived(
		explicitHistory && historySelectionText != null ? historySelectionText : copy.crowding.window,
	);

	const crowdingPresent = $derived(
		crowdingSettled && crowding.hasCrowding && crowding.dominant != null && crowding.spec != null,
	);
	const sourceHref = $derived(`${localizeHref('/metrics', locale)}#severe`);

	// Only sections that show something are listed and rendered: no empty card, no empty entry.
	const sectionNav = $derived(
		[
			{ id: 'stop-rel-trend', label: copy.dayByDay.heading, present: dayByDayPresent },
			{
				id: 'stop-rel-percentiles',
				label: copy.percentiles.heading,
				present: dayPercentiles != null,
			},
			{ id: 'stop-rel-pane', label: copy.paneHeading, present: gradedPeriods.length > 0 },
			{ id: 'stop-rel-habits', label: copy.habits.heading, present: habitsPresent },
			{ id: 'stop-rel-weekday', label: copy.weekday.heading, present: hasWeekday },
			{ id: 'stop-rel-time', label: copy.timeOfDay.heading, present: timeOfDay.hasTimeOfDay },
			{ id: 'stop-rel-crowding', label: copy.crowding.heading, present: crowdingPresent },
			{ id: 'stop-rel-by-route', label: copy.byRoute, present: rankedRoutes.length > 0 },
			{ id: 'stop-rel-source', label: copy.source.heading, present: true },
		].filter((s) => s.present),
	);

	const fmtMinutes = (v: number | null) => fmtDelayMin(v, { locale, rounding: 'fixed1' });
	const percentilesSummary = $derived(
		dayPercentiles?.p50 != null && dayPercentiles.p90 != null
			? copy.summaries.percentiles(fmtMinutes(dayPercentiles.p50)!, fmtMinutes(dayPercentiles.p90)!)
			: null,
	);
	const byRouteSummary = $derived(
		copy.summaries.byRoute(rankedRoutes.length, intl.number(locale).format(rankedRoutes.length)),
	);
	const crowdingSummary = $derived(
		explicitHistory && historySelectionText != null
			? historySelectionText
			: copy.summaries.crowding,
	);

	const tocEntries: TocEntry[] = $derived(
		sectionNav.map((s, i) => ({
			id: s.id,
			title: s.label,
			level: 2,
			badge: { kind: 'number' as const, value: i + 1 },
			children: [],
		})),
	);
	const sectionIndex = (id: string): number => sectionNav.findIndex((section) => section.id === id);

	const navigation = useSectionJump(afterNavigate);
	let sectionRoot = $state<HTMLElement>();
	$effect(() => {
		if (sectionRoot)
			return navigation.register(tocEntries, { root: sectionRoot, landFragments: true });
	});
	const navigate = (id: string) =>
		navigation.jump(id, { behavior: $prefersReducedMotion ? 'auto' : 'smooth' });
</script>

{#snippet allHistoryCaption()}
	{#if allHistoryScope}
		<p class="stop-reliability-window" data-slot="all-history-scope">{allHistoryScope}</p>
	{/if}
{/snippet}

{#snippet finding(text: string)}
	<p class="stop-section-finding">{text}</p>
{/snippet}
{#snippet dayByDayFinding()}{@render finding(dayByDaySummary(dayByDay, locale))}{/snippet}
{#snippet percentilesFinding()}{@render finding(percentilesSummary ?? '')}{/snippet}
{#snippet paneFinding()}{@render finding(windowCaption)}{/snippet}
{#snippet habitsFinding()}{@render finding(copy.summaries.habits)}{/snippet}
{#snippet allHistoryFinding()}{@render finding(copy.summaries.allHistory)}{/snippet}
{#snippet crowdingFinding()}{@render finding(crowdingSummary)}{/snippet}
{#snippet byRouteFinding()}{@render finding(byRouteSummary)}{/snippet}
{#snippet sourceFinding()}{@render finding(copy.source.summary)}{/snippet}

{#snippet metricInfo(key: MetricKey | SupplementalMetricKey, name: string)}
	<MetricInfo class="stop-metric-info" metricKey={key} {locale} {name} side="bottom" />
{/snippet}

<div bind:this={sectionRoot} class="stop-reliability">
	<div data-slot="stop-reliability-sections">
		{#snippet railContent({ closeSheet }: { closeSheet: () => void })}
			{#snippet historyControls()}
				<HistoryNavigator {...view.navigator!} />
			{/snippet}
			{#snippet primaryControls()}
				<GrainPicker
					segments={grainSegments}
					value={view.grain}
					onSelect={view.selectGrain}
					label={copy.grain.label}
					variant="time-grid"
				/>
			{/snippet}
			{#snippet windowCaptionControl()}
				<p class="stop-reliability-window" data-slot="active-window" aria-live="polite">
					{windowCaption}
				</p>
			{/snippet}

			<CollapsibleSection independent title={copy.controlsLabel}>
				<ArticleControlStack
					history={availableHistoryDates.length > 0 ? historyControls : undefined}
					primary={primaryControls}
					caption={windowCaptionControl}
				/>
			</CollapsibleSection>

			<div class="rail-toc" data-slot="section-toc">
				<TocNav
					entries={tocEntries}
					{navigation}
					onNavigate={(id) => {
						closeSheet();
						void navigate(id);
					}}
					heading={copy.nav.toc}
				/>
			</div>
		{/snippet}

		{#snippet reliabilityContent()}
			<p
				class="stop-history-announcement sr-only"
				data-slot="history-page-announcement"
				role="status"
				aria-live="polite"
				aria-atomic="true"
			>
				{historyLiveAnnouncement}
			</p>

			<div class="stop-reliability-content">
				{#if historyAnnouncement}
					<p class="stop-history-correction" data-slot="history-correction">
						{historyAnnouncement}
					</p>
				{/if}
				{#if explicitHistory}
					{#if view.history.state === 'no-data'}
						<StateNotice
							title={retainedDataAbsence.label}
							body={retainedDataBody}
							presentation="responsive"
							data-slot="history-no-data"
						/>
					{:else}
						<div class="stop-history-state" data-slot="history-state">
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
							<p data-slot="history-current-only">{copy.history.currentOnly}</p>
						</div>
					{/if}
				{/if}
				<ArticleSectionStack>
					{#if dayByDayPresent}
						<div class="stop-anchor" id="stop-rel-trend">
							<CollapsibleSection
								title={copy.dayByDay.heading}
								headerVariant="article-summary"
								summary={dayByDayHeld ? undefined : dayByDayFinding}
								anchor="stop-rel-trend"
								index={sectionIndex('stop-rel-trend')}
								open={true}
							>
								{#snippet headerActions()}
									{@render metricInfo('severe', copy.dayByDay.heading)}
								{/snippet}
								{#if dayByDayHeld}
									<p class="stop-reliability-window" data-slot="day-by-day-held">
										{dayByDayHeld}
									</p>
								{:else}
									<SectionDailyTrend view={dayByDay} {locale} {copy} presentation="article-body" />
								{/if}
							</CollapsibleSection>
						</div>
					{/if}

					{#if dayPercentiles != null}
						<div class="stop-anchor" id="stop-rel-percentiles">
							<CollapsibleSection
								title={copy.percentiles.heading}
								headerVariant="article-summary"
								summary={percentilesSummary ? percentilesFinding : undefined}
								anchor="stop-rel-percentiles"
								index={sectionIndex('stop-rel-percentiles')}
								open={false}
							>
								{#snippet headerActions()}
									{@render metricInfo('p50p90', copy.percentiles.heading)}
								{/snippet}
								<SectionPercentiles
									percentiles={dayPercentiles}
									dailyPercentiles={retainedPercentiles}
									scope={explicitHistory ? undefined : copy.scope.latestDay}
									{locale}
									{copy}
									presentation="article-body"
								/>
							</CollapsibleSection>
						</div>
					{/if}

					{#if gradedPeriods.length > 0}
						<div class="stop-anchor" id="stop-rel-pane">
							<CollapsibleSection
								title={copy.paneHeading}
								headerVariant="article-summary"
								summary={paneFinding}
								anchor="stop-rel-pane"
								index={sectionIndex('stop-rel-pane')}
								open={false}
							>
								<div class="stop-reliability-pane-body" data-slot="stop-reliability-pane">
									{#if explicitHistory}
										<p class="stop-prediction-scope" data-slot="prediction-scope">
											{copy.history.predictionScope}
										</p>
									{/if}
									<VerdictBanner result={stopVerdict} />
									<ReliabilityPane periods={gradedPeriods} {locale} {metricInfo} />
								</div>
							</CollapsibleSection>
						</div>
					{/if}

					{#if habitsPresent}
						<div class="stop-anchor" id="stop-rel-habits">
							<CollapsibleSection
								title={copy.habits.heading}
								headerVariant="article-summary"
								summary={habitsFinding}
								anchor="stop-rel-habits"
								index={sectionIndex('stop-rel-habits')}
								open={false}
							>
								{#snippet headerActions()}
									{@render metricInfo('habits', copy.habits.heading)}
								{/snippet}
								{@render allHistoryCaption()}
								<SectionHabits matrix={habitsMatrix} {locale} {copy} presentation="article-body" />
							</CollapsibleSection>
						</div>
					{/if}

					{#if hasWeekday}
						<div class="stop-anchor" id="stop-rel-weekday">
							<CollapsibleSection
								title={copy.weekday.heading}
								headerVariant="article-summary"
								summary={allHistoryFinding}
								anchor="stop-rel-weekday"
								index={sectionIndex('stop-rel-weekday')}
								open={false}
							>
								{#snippet headerActions()}
									{@render metricInfo('seasonality', copy.weekday.heading)}
								{/snippet}
								{@render allHistoryCaption()}
								<SectionWeekday rows={rankedWeekdays} {locale} {copy} presentation="article-body" />
							</CollapsibleSection>
						</div>
					{/if}
					{#if timeOfDay.hasTimeOfDay}
						<div class="stop-anchor" id="stop-rel-time">
							<CollapsibleSection
								title={copy.timeOfDay.heading}
								headerVariant="article-summary"
								summary={allHistoryFinding}
								anchor="stop-rel-time"
								index={sectionIndex('stop-rel-time')}
								open={false}
							>
								{#snippet headerActions()}
									{@render metricInfo('severe', copy.timeOfDay.heading)}
								{/snippet}
								{@render allHistoryCaption()}
								<SectionTimeOfDay
									shiftRows={timeOfDay.shiftRows}
									dayTypeRows={timeOfDay.dayTypeRows}
									{locale}
									{copy}
									presentation="article-body"
								/>
							</CollapsibleSection>
						</div>
					{/if}

					{#if crowdingPresent}
						<div class="stop-anchor" id="stop-rel-crowding">
							<CollapsibleSection
								title={copy.crowding.heading}
								headerVariant="article-summary"
								summary={crowdingFinding}
								anchor="stop-rel-crowding"
								index={sectionIndex('stop-rel-crowding')}
								open={false}
							>
								{#snippet headerActions()}
									{@render metricInfo('occupancy', copy.crowding.heading)}
								{/snippet}
								<SectionCrowding
									vm={crowding}
									{locale}
									{copy}
									windowText={crowdingWindowText}
									presentation="article-body"
								/>
							</CollapsibleSection>
						</div>
					{/if}
					{#if rankedRoutes.length > 0}
						<div class="stop-anchor" id="stop-rel-by-route">
							<CollapsibleSection
								title={copy.byRoute}
								headerVariant="article-summary"
								summary={byRouteFinding}
								anchor="stop-rel-by-route"
								index={sectionIndex('stop-rel-by-route')}
								open={false}
							>
								{#snippet headerActions()}
									{@render metricInfo('avgDelay', copy.byRoute)}
								{/snippet}
								<SectionByRoute rows={rankedRoutes} {locale} {copy} presentation="article-body" />
							</CollapsibleSection>
						</div>
					{/if}
					<div class="stop-anchor" id="stop-rel-source">
						<CollapsibleSection
							title={copy.source.heading}
							headerVariant="article-summary"
							summary={sourceFinding}
							anchor="stop-rel-source"
							index={sectionIndex('stop-rel-source')}
							open={false}
						>
							<SectionSource {data} {locale} {copy} href={sourceHref} />
						</CollapsibleSection>
					</div>
				</ArticleSectionStack>
			</div>
		{/snippet}

		<ReliabilityRailLayout
			rail={railContent}
			content={reliabilityContent}
			{articleSummary}
			label={copy.controlsLabel}
			summary={grainSummary}
			openAria={copy.nav.pillOpen}
			closeAria={copy.nav.pillClose}
		/>
	</div>
</div>

<style>
	.stop-reliability {
		display: flex;
		flex-direction: column;
		width: 100%;
	}

	.stop-reliability-content {
		display: flex;
		flex-direction: column;
		gap: var(--space-card-gap);
		min-width: 0;
	}
	.stop-history-state,
	.stop-history-correction {
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
	.stop-history-state {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		color: var(--muted-foreground);
	}
	.stop-history-state p {
		margin: 0;
	}

	.stop-reliability-window,
	.stop-prediction-scope {
		margin: 0;
		font-family: var(--font-mono);
		font-size: var(--text-caption);
		line-height: 1.3;
		color: var(--muted-foreground);
	}

	.stop-anchor {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.stop-anchor > :global([data-slot='card'].section-card) {
		flex: 1;
		min-width: 0;
	}
	@media (prefers-reduced-motion: no-preference) {
		:global([data-slot='reliability-rail-layout']) {
			scroll-behavior: smooth;
		}
	}

	.stop-section-finding {
		margin: 0;
		max-width: var(--measure-body);
		font-size: var(--text-small);
		line-height: 1.5;
		color: var(--muted-foreground);
	}

	.stop-reliability-pane-body {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 0;
	}
</style>
