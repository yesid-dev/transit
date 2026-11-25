<script lang="ts">
	import { DashboardGrid } from '@yesid/ui/layout';
	import type { Locale } from '#lib/i18n/index.ts';
	import { localizeHref } from '#lib/i18n/routing.ts';
	import { RECORD_START } from '#lib/site/frameState.ts';
	import {
		countedUnit,
		longDate,
		methodEvidence,
		recordDenominator,
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
	import RecordPending from '../record/RecordPending.svelte';
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
		percent,
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
		record,
	}: {
		locale: Locale;
		city: string;
		operator?: string;
		mode?: 'live' | 'record';
		provider: string;
		href: string;
		alertsAvailable?: boolean;
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
		value={value == null ? null : percent(value, locale)}
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
				<p
					class="flex w-full flex-wrap justify-between gap-x-3 border-t border-border pt-2 font-mono text-sm text-muted-foreground"
				>
					<span>{counted}</span>
					{#if current.kind === 'answer' && current.answer.state === 'measured'}<span
							>{methodEvidence(current.answer.evidence, locale, true)}</span
						>{/if}
				</p>
			{/if}
		{/await}
	{/await}
{/snippet}

<div class="overview grid min-w-0 gap-6">
	{#await record.totals}
		<ScreenTitle title={t.title(city)} />
	{:then totals}
		<ScreenTitle
			title={t.title(city)}
			subtitle={totals
				? `${operator}${locale === 'fr' ? '\u00a0' : ''}: ${countedUnit(totals.lines, 'line', locale)}, ${countedUnit(totals.stops, 'stop', locale)}`
				: undefined}
		/>
	{/await}
	<p class="border-t border-border pt-4">{t.intro}</p>

	<div class="grid min-w-0 gap-6" data-slot="screen-content">
		{#snippet recordCard()}
			<RecordCard title={t.record} {stamp}>
				{#await record.punctuality}
					{#key record.punctuality}<RecordPending {locale} answer={record.punctuality} />{/key}
					{@render actions()}
				{:then current}
					{#if current.kind === 'busy'}
						<RecordPending {locale} busy />
						{@render actions()}
					{:else}
						{@render lead(current)}
						{#if current.kind === 'answer' && current.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
					{/if}
				{/await}
				<dl class="readings mt-4 grid gap-3">
					{#await record.punctuality then current}
						{#if current.kind === 'answer' && overviewValue(current, 'on_time') != null}
							{@const { on_time, classified } = current.answer.evidence.counts}
							{#if on_time != null && classified != null}
								<div class="reading on-time">
									<dt>{t.onTime}</dt>
									<dd>
										<strong>{tally(on_time, locale)}</strong>
										<span class="block text-muted-foreground"
											>{recordDenominator(countedUnit(classified, 'event', locale), locale)}</span
										>
									</dd>
								</div>
							{/if}
						{:else if current.kind !== 'answer' && current.kind !== 'busy'}
							<div class="reading">
								<dt>{t.onTime}</dt>
								<dd>{t.unavailable}</dd>
							</div>
						{/if}
					{/await}
					<div class="reading">
						<dt>
							{record.period.from === record.period.to ? t.previousWeekday : t.previous(days)}
						</dt>
						<dd>
							{#await record.baseline}
								{#key record.baseline}<RecordPending {locale} answer={record.baseline} />{/key}
							{:then previous}
								{@const share = overviewValue(previous, 'on_time')}
								{#if share == null}
									{@render gap(previous)}
									<span class="block text-muted-foreground"
										>{dateRange(record.previous, locale)}</span
									>
								{:else}
									{#await record.punctuality then current}
										<strong
											>{comparisonText(current, previous, locale) ??
												t.comparisonUnavailable}</strong
										>
									{/await}
									<span class="block text-muted-foreground"
										>{percent(share, locale)}, {dateRange(record.previous, locale)}</span
									>
								{/if}
								{#if previous.kind === 'answer' && previous.lastGood}<p>
										{lastGoodNote[locale]}
									</p>{/if}
							{/await}
						</dd>
					</div>
					<div class="reading">
						<dt>{t.delivery}</dt>
						<dd>
							{#await record.delivery}
								{#key record.delivery}<RecordPending {locale} answer={record.delivery} />{/key}
							{:then delivery}
								{@const share = overviewValue(delivery, 'trips_run')}
								{#if delivery.kind === 'answer' && share != null}
									{@const { ran, eligible } = delivery.answer.evidence.counts}
									<strong>{percent(share, locale)}</strong>
									{#if ran != null && eligible != null}<span class="block text-muted-foreground"
											>{recordRatio(ran, countedUnit(eligible, 'trip', locale), locale)}</span
										>{/if}
									{#if delivery.answer.evidence.low_coverage}
										<p class="text-muted-foreground">
											{coverageText(delivery.answer.evidence, locale)}
										</p>
									{/if}
									{#if delivery.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
								{:else}{@render gap(delivery)}{/if}
							{/await}
						</dd>
					</div>
				</dl>
				{#if record.trend}
					<div class="mt-4">
						<h3 class="font-semibold">{t.trend}</h3>
						{#await record.trend}
							{#key record.trend}<RecordPending {locale} answer={record.trend} />{/key}
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
				{#snippet footer()}
					<a
						class="inline-flex min-h-11 items-center text-primary underline"
						href={link('/network')}>{t.fullRecord}</a
					>
					{@render evidenceFooter()}
					{#if record.trend}
						{#await record.trend then trend}
							{#if trend.kind === 'answer' && 'cells' in trend.answer && trend.answer.cells.length}
								<RecordChartToggle
									bind:table={trendTable}
									controls="overview-record-trend"
									{locale}
								/>
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
					{link}
					onCaptureAge={(age) => (liveCaptureAge = age)}
				/>
			{/key}
		{/snippet}
		<DashboardGrid gutter={false} minTile="22rem" data-slot="screen-answer">
			{#each mode === 'live' ? [liveCard, recordCard] : [recordCard, liveCard] as card (card)}
				{@render card()}
			{/each}
		</DashboardGrid>

		<RecordCard title={t.rankings} {stamp}>
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
			{#snippet footer()}
				<a class="inline-flex min-h-11 items-center text-primary underline" href={link('/hotspots')}
					>{t.allRankings}</a
				>
				{@render evidenceFooter()}
			{/snippet}
		</RecordCard>

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
										percent(observed, locale),
										scheduled == null ? undefined : tally(scheduled, locale),
									),
							current?.evidence.low_coverage ? lowCoverageText(locale) + '.' : null,
							basis,
							current?.coverage_note?.[locale],
							delivery &&
							!delivery.evidence.low_coverage &&
							(delivery.evidence.share_eligible ?? 1) < 1
								? coverageText(delivery.evidence, locale) + '.'
								: null,
						]
							.filter(Boolean)
							.join(' '),
					},
					{ key: 'means', label: t.means, text: t.definition },
					{
						key: 'versions',
						label: t.versions,
						text: current ? methodEvidence(current.evidence, locale) : null,
					},
					{
						key: 'source',
						label: t.source,
						text: `${t.feeds(operator)} ${t.recordStart(locale === 'fr' ? longDate(RECORD_START, locale) : dateRange({ from: RECORD_START, to: RECORD_START }, locale))}`,
					},
				]}
				versionsLink={{ href: link('/metrics'), label: t.method }}
			/>
		{/snippet}
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
	</div>
</div>

<style>
	.overview {
		overflow-wrap: break-word;
	}
	.readings {
		container-type: inline-size;
	}
	.reading {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		align-items: baseline;
		gap: 0.25em 1em;
		border-block-start: 1px solid var(--border);
		padding-block-start: 0.5em;
	}
	.reading dd {
		text-align: end;
	}
	.reading.on-time {
		grid-template-columns: fit-content(40%) minmax(0, 1fr);
	}
	@container (max-width: 16rem) {
		.reading,
		.reading.on-time {
			grid-template-columns: minmax(0, 1fr);
		}
		.reading dd {
			text-align: start;
		}
	}
</style>
