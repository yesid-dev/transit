<script lang="ts">
	import { DashboardGrid } from '@yesid/ui/layout';
	import type { Locale } from '#lib/i18n/index.ts';
	import { localizeHref } from '#lib/i18n/routing.ts';
	import { page } from '$app/state';
	import { recordStart } from '#lib/site/frameState.ts';
	import {
		countedUnit,
		longDate,
		methodEvidence,
		recordDenominator,
		recordPercent,
		recordRatio,
		recordStamp,
	} from '#lib/site/presenter.ts';
	import type {
		EngineResult,
		MeasureAnswer,
		RankingAnswer,
		RecordAnswer as EngineRecord,
	} from '#lib/server/engine.ts';
	import type { DateWindow } from '#lib/v1/history/window.ts';
	import type { Manifest } from '#lib/v1/schemas/index.ts';
	import type { ScheduleEdition } from '#lib/search/searchIndex.ts';
	import AboutFigures from '../record/AboutFigures.svelte';
	import RecordActionGroup from '../record/RecordActionGroup.svelte';
	import RecordAnswer from '../record/RecordAnswer.svelte';
	import RecordCard from '../record/RecordCard.svelte';
	import RecordEvidenceLine from '../record/RecordEvidenceLine.svelte';
	import RecordScreen from '../record/RecordScreen.svelte';
	import RecordGroup from '../record/RecordGroup.svelte';
	import FactList from '../record/FactList.svelte';
	import FactRow from '../record/FactRow.svelte';
	import RecordPending from '../record/RecordPending.svelte';
	import RecordSkeleton from '../record/RecordSkeleton.svelte';
	import RecordChart from '../record/charts/RecordChart.svelte';
	import RecordChartToggle from '../record/charts/RecordChartToggle.svelte';
	import ScreenTitle from '../record/ScreenTitle.svelte';
	import StateMark from '../record/StateMark.svelte';
	import { recordSectionLinks } from '../record/recordLinks.ts';
	import {
		lastGoodNote,
		recordConnection,
		timingBasis,
		coverageText,
		lowCoverageText,
	} from '../record/recordText.ts';
	import { periodDays } from './periodComparison.ts';
	import AboutLiveFigures from '../record/AboutLiveFigures.svelte';
	import OverviewLiveCard from './OverviewLiveCard.svelte';
	import RecordRanking from './RecordRanking.svelte';
	import {
		citationText,
		comparisonText,
		dateRange,
		overviewState,
		overviewValue,
		recordCounts,
		tally,
	} from './overviewRecord.ts';
	import { overviewCopy } from './overviewRecord.copy.ts';

	type Measure = Promise<EngineResult<MeasureAnswer>>;
	type Ranking = Promise<EngineResult<RankingAnswer>>;
	type Totals = { lines: number; stops: number } | null;

	let {
		locale,
		city,
		operator = city,
		mode = 'record',
		provider,
		href,
		alertsAvailable = false,
		officialAlertsUrl,
		operatorOf,
		record,
	}: {
		locale: Locale;
		city: string;
		operator?: string;
		mode?: 'live' | 'record';
		provider: string;
		href: string;
		alertsAvailable?: boolean;
		officialAlertsUrl?: string;
		operatorOf?: string | null;
		record: {
			period: DateWindow;
			previous: DateWindow;
			punctuality: Measure;
			baseline: Measure;
			delivery: Measure;
			lines: Ranking;
			stops: Ranking;
			directory?: Promise<ScheduleEdition['stops']>;
			totals?: Totals | Promise<Totals>;
			trend?: Promise<EngineResult<EngineRecord>>;
			manifest?: Manifest | null;
		};
	} = $props();
	const t = $derived(overviewCopy[locale]);
	const cityStart = $derived(recordStart(page.data.provider));
	let trendTable = $state(false);
	const stamp = $derived({ kind: 'record' as const, label: recordStamp(record.period, locale) });
	const days = $derived(
		countedUnit(periodDays(record.period.from, record.period.to), 'day', locale),
	);
	const rankings = $derived(Promise.all([record.lines, record.stops]));

	function link(path: string, live = false) {
		const target = new URL(localizeHref(path, locale, provider), href);
		target.searchParams.set('frameMode', live ? 'live' : 'record');
		target.searchParams.set('recordFrom', record.period.from);
		target.searchParams.set('recordTo', record.period.to);
		return target.pathname + target.search;
	}

	function file(section: string, label: string) {
		const url = new URL(href);
		url.searchParams.set('provider', provider);
		url.searchParams.set('recordFrom', record.period.from);
		url.searchParams.set('recordTo', record.period.to);
		return { href: recordSectionLinks(url, section).csv, label };
	}

	const files = $derived([
		file('punctuality', t.onTime),
		file('previous', t.previousFile),
		file('delivery', t.delivery),
		file('trend', t.trend),
		file('lines', t.downloadRankings),
		file('stops', t.downloadStops),
	]);
	let liveCaptureAge = $state<number | null>(null);
	const overviewReadings = $derived(
		Promise.all([record.punctuality, record.baseline, record.delivery]).then(
			([current, previous, delivery]) => ({ kind: current.kind, current, previous, delivery }),
		),
	);
</script>

{#snippet citeMeasure(promise: Measure, period: DateWindow)}
	{#await promise then result}
		{#if result.kind === 'answer' && result.answer.state === 'measured'}
			<p>{citationText(result.answer, period, locale)}</p>
		{/if}
	{/await}
{/snippet}

{#snippet citation()}
	<p>Transit{city ? ` · ${city}` : ''}. {dateRange(record.period, locale)}.</p>
	{@render citeMeasure(record.punctuality, record.period)}
	{@render citeMeasure(record.baseline, record.previous)}
	{@render citeMeasure(record.delivery, record.period)}
{/snippet}

{#snippet actions()}
	<RecordActionGroup {locale} {href} {files} {citation} />
{/snippet}

{#snippet lead(current: EngineResult<MeasureAnswer>)}
	{@const value = overviewValue(current, 'on_time')}
	{@const gap = overviewState(current, locale)}
	<RecordAnswer
		{locale}
		value={value == null ? null : recordPercent(value, locale)}
		sentence={value != null ? t.answer : gap.sentence}
		state={gap.state}
		{actions}
	>
		{#snippet meta()}{#if gap.detail}<p>{gap.detail}</p>{/if}{/snippet}
	</RecordAnswer>
{/snippet}

{#snippet gap(result: EngineResult<MeasureAnswer>)}
	{#if result.kind === 'busy'}<RecordPending {locale} busy />
	{:else}
		{@const state = overviewState(result, locale)}
		{#if state.state}<StateMark state={state.state} {locale} />
		{:else}<p>{t.unavailable}</p>{/if}
		{#if state.detail}<p class="text-muted-foreground">{state.detail}</p>{/if}
	{/if}
{/snippet}

{#snippet evidenceFooter()}
	{#await record.punctuality then current}
		{#await record.delivery then delivery}
			{@const events =
				current.kind === 'answer' && current.answer.state === 'measured'
					? current.answer.evidence.counts.classified
					: null}
			{@const trips =
				delivery.kind === 'answer' && delivery.answer.state === 'measured'
					? delivery.answer.evidence.counts.ran
					: null}
			{@const counted = recordCounts(events, trips, days, locale)}
			{#if counted}
				<RecordEvidenceLine
					{locale}
					sample={counted}
					versions={current.kind === 'answer' && current.answer.state === 'measured'
						? methodEvidence(current.answer.evidence, locale, true)
						: ''}
				/>
			{/if}
		{/await}
	{/await}
{/snippet}

{#snippet recordCard()}
	{@const previousLabel =
		record.period.from === record.period.to ? t.previousWeekday : t.previous(days)}
	<RecordCard interactive title={t.record} {stamp}>
		{#await overviewReadings}
			<RecordPending shape="reading" {locale} answer={overviewReadings} />
			{@render actions()}
			<RecordSkeleton shape="facts" />
		{:then { current, previous, delivery }}
			{#if current.kind === 'busy'}
				<RecordPending {locale} busy />
				{@render actions()}
			{:else}
				{@render lead(current)}
				{#if current.kind === 'answer' && current.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
			{/if}
			<FactList class="mt-4">
				{#if current.kind === 'answer' && overviewValue(current, 'on_time') != null}
					{@const { on_time, classified } = current.answer.evidence.counts}
					{#if on_time != null && classified != null}
						<FactRow
							label={t.onTime}
							detail={recordDenominator(countedUnit(classified, 'event', locale), locale)}
						>
							<strong>{tally(on_time, locale)}</strong>
						</FactRow>
					{/if}
				{:else if current.kind !== 'answer' && current.kind !== 'busy'}
					<FactRow label={t.onTime}>{t.unavailable}</FactRow>
				{/if}
				{@const share = overviewValue(previous, 'on_time')}
				{@const range = dateRange(record.previous, locale)}
				<FactRow
					label={previousLabel}
					detail={share == null ? range : `${recordPercent(share, locale)}, ${range}`}
				>
					{#if share == null}
						{@render gap(previous)}
					{:else}
						<strong>{comparisonText(current, previous, locale) ?? t.comparisonUnavailable}</strong>
					{/if}
					{#if previous.kind === 'answer' && previous.lastGood}<p>
							{lastGoodNote[locale]}
						</p>{/if}
				</FactRow>
				{@const deliveryShare = overviewValue(delivery, 'trips_run')}
				{#if delivery.kind === 'answer' && deliveryShare != null}
					{@const { ran, eligible } = delivery.answer.evidence.counts}
					<FactRow
						label={t.delivery}
						detail={ran != null && eligible != null
							? recordRatio(ran, countedUnit(eligible, 'trip', locale), locale)
							: undefined}
					>
						<strong>{recordPercent(deliveryShare, locale)}</strong>
						{#if delivery.answer.evidence.low_coverage}
							<p class="text-muted-foreground">
								{coverageText(delivery.answer.evidence, locale)}
							</p>
						{/if}
						{#if delivery.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
					</FactRow>
				{:else}
					<FactRow label={t.delivery}>{@render gap(delivery)}</FactRow>
				{/if}
			</FactList>
		{/await}
		{#if record.trend}
			<div class="mt-4">
				<h3 class="font-semibold">{t.trend}</h3>
				{#await record.trend}
					{#key record.trend}<RecordPending shape="trend" {locale} answer={record.trend} />{/key}
				{:then trend}
					{#if trend.kind === 'busy'}<RecordPending {locale} busy />
					{:else if trend.kind !== 'answer'}<p>{t.unavailable}</p>
					{:else if 'cells' in trend.answer && trend.answer.cells.length}
						<RecordChart
							title={t.trend}
							id="overview-record-trend"
							table={trendTable}
							input={{ kind: 'trend', answer: trend.answer }}
							{locale}
						/>
					{:else}
						{@const state = 'cells' in trend.answer ? trend.answer.state : undefined}
						<StateMark
							state={state != null && state !== 'measured' ? state : 'not_measured'}
							{locale}
						/>
					{/if}
				{/await}
			</div>
		{/if}
		{#snippet links()}
			<a class="inline-flex min-h-11 items-center text-primary underline" href={link('/network')}
				>{t.fullRecord}</a
			>
		{/snippet}
		{#snippet evidence()}
			{@render evidenceFooter()}
		{/snippet}
		{#snippet toggle()}
			{#if record.trend}
				{#await record.trend then trend}
					{#if trend.kind === 'answer' && 'cells' in trend.answer && trend.answer.cells.length}
						<RecordChartToggle bind:table={trendTable} controls="overview-record-trend" {locale} />
					{/if}
				{/await}
			{/if}
		{/snippet}
	</RecordCard>
{/snippet}

{#snippet liveCard()}
	{#key record.manifest?.provider}
		<OverviewLiveCard
			{locale}
			manifest={record.manifest ?? null}
			{alertsAvailable}
			{operator}
			{officialAlertsUrl}
			{operatorOf}
			{link}
			onCaptureAge={(age) => (liveCaptureAge = age)}
		/>
	{/key}
{/snippet}

{#snippet evidence(current: MeasureAnswer | null, delivery: MeasureAnswer | null)}
	{@const counts = current?.evidence.counts}
	{@const events = counts?.classified}
	{@const trips = delivery?.evidence.counts.ran}
	{@const observed = current?.evidence.share_observed}
	{@const scheduled = counts?.scheduled ?? counts?.punctuality_scheduled}
	{@const basis = timingBasis(counts, locale)}
	<AboutFigures
		title={t.about}
		fields={[
			{ key: 'period', label: t.period, text: `${dateRange(record.period, locale)}, ${days}.` },
			{
				key: 'counted',
				label: t.counted,
				text: recordCounts(events, trips, days, locale),
			},
			{
				key: 'observed',
				label: t.observed,
				text: [
					observed == null
						? null
						: t.observedShare(
								recordPercent(observed, locale),
								scheduled == null ? undefined : tally(scheduled, locale),
							),
					current?.evidence.low_coverage ? lowCoverageText(locale) + '.' : null,
					basis,
					current?.coverage_note?.[locale],
					delivery && !delivery.evidence.low_coverage && (delivery.evidence.share_eligible ?? 1) < 1
						? coverageText(delivery.evidence, locale) + '.'
						: null,
				]
					.filter(Boolean)
					.join(' '),
			},
			{ key: 'means', label: t.means, text: t.definition },
			{
				key: 'method',
				label: t.methodRow,
				text: null,
				link: { href: link('/metrics'), label: t.method },
			},
			{
				key: 'source',
				label: t.source,
				text: `${t.feeds(operator)} ${t.recordStart(locale === 'fr' ? longDate(cityStart, locale) : dateRange({ from: cityStart, to: cityStart }, locale))}`,
			},
		]}
	/>
{/snippet}

<RecordScreen class="min-w-0 wrap-break-word">
	<RecordGroup>
		{#await record.totals}
			<ScreenTitle title={t.title(city)} subtitle={operator} />
		{:then totals}
			<ScreenTitle
				title={t.title(city)}
				subtitle={totals
					? `${operator}${locale === 'fr' ? '\u00a0' : ''}: ${countedUnit(totals.lines, 'line', locale)}, ${countedUnit(totals.stops, 'stop', locale)}`
					: undefined}
			/>
		{/await}
	</RecordGroup>
	<div data-slot="screen-content">
		<RecordGroup>
			<p data-screen-intro>{t.intro}</p>

			<DashboardGrid gutter={false} minTile="22rem" data-slot="screen-answer">
				{#each mode === 'live' ? [liveCard, recordCard] : [recordCard, liveCard] as card (card)}
					{@render card()}
				{/each}
			</DashboardGrid>
		</RecordGroup>
		<RecordGroup>
			<RecordCard interactive title={t.rankings} {stamp}>
				<p class="mb-3 text-muted-foreground">{t.rankingIntro}</p>
				{#await rankings then results}
					{@const failure = results
						.map(({ kind }) => kind)
						.find((kind) => kind !== 'answer' && kind !== 'busy')}
					{#if failure}<p class="mb-3">{recordConnection[failure][locale]}</p>{/if}
				{/await}
				<DashboardGrid gutter={false} minTile="18rem">
					<RecordRanking {locale} kind="line" ranking={record.lines} {link} />
					<RecordRanking
						{locale}
						kind="stop"
						ranking={record.stops}
						{link}
						directory={record.directory}
					/>
				</DashboardGrid>
				{#snippet links()}
					<a
						class="inline-flex min-h-11 items-center text-primary underline"
						href={link('/rankings')}>{t.allRankings}</a
					>
				{/snippet}
			</RecordCard>
		</RecordGroup>
		<RecordGroup>
			{#if mode === 'live'}
				<AboutLiveFigures
					{locale}
					{operator}
					healthLink={link('/status', true)}
					captureAge={liveCaptureAge}
				/>
			{:else}
				{#await record.punctuality then current}
					{#await record.delivery then delivery}
						{@render evidence(
							current.kind === 'answer' ? current.answer : null,
							delivery.kind === 'answer' ? delivery.answer : null,
						)}
					{/await}
				{/await}
			{/if}
		</RecordGroup>
	</div>
</RecordScreen>
