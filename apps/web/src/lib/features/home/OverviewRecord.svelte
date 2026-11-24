<script lang="ts">
	import { DashboardGrid } from '@yesid/ui/layout';
	import type { Locale } from '#lib/i18n/index.ts';
	import { localizeHref } from '#lib/i18n/routing.ts';
	import { RECORD_START } from '#lib/site/frameState.ts';
	import { countedUnit, methodEvidence, recordRatio, recordStamp } from '#lib/site/presenter.ts';
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
	import RecordPunctualityDays from '../record/RecordPunctualityDays.svelte';
	import ScreenTitle from '../record/ScreenTitle.svelte';
	import StateMark from '../record/StateMark.svelte';
	import { recordState } from '../record/recordStates';
	import { recordSectionLinks } from '../record/recordLinks.ts';
	import {
		lastGoodNote,
		recordConnection,
		timingBasis,
		coverageText,
	} from '../record/recordText.ts';
	import { periodDays } from './periodComparison.ts';
	import OverviewLiveCard from './OverviewLiveCard.svelte';
	import RecordRanking from './RecordRanking.svelte';
	import {
		citationText,
		comparisonText,
		dateRange,
		overviewState,
		overviewValue,
		percent,
	} from './overviewRecord.ts';
	import { overviewCopy } from './overviewRecord.copy.ts';

	type Measure = Promise<EngineResult<MeasureAnswer>>;
	type Ranking = Promise<EngineResult<RankingAnswer>>;

	let {
		locale,
		city,
		operator = city,
		provider = 'stm',
		href,
		alertsAvailable = false,
		record,
	}: {
		locale: Locale;
		city: string;
		operator?: string;
		provider?: string;
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
			totals?: { lines: number; stops: number } | null;
			trend?: Promise<EngineResult<EngineRecord>>;
			manifest?: Manifest | null;
		};
	} = $props();
	const t = $derived(overviewCopy[locale]);
	const stamp = $derived({ kind: 'record' as const, label: recordStamp(record.period, locale) });
	const days = $derived(
		countedUnit(periodDays(record.period.from, record.period.to), 'day', locale),
	);

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
		file('previous', t.previous),
		file('delivery', t.delivery),
		file('trend', t.trend),
		file('lines', t.downloadRankings),
		file('stops', t.downloadStops),
	]);
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

{#snippet lead(current: EngineResult<MeasureAnswer> | null, comparison?: string)}
	{@const value = current ? overviewValue(current, 'on_time') : null}
	{@const absent = current ? overviewState(current, locale) : null}
	<RecordAnswer
		{locale}
		value={value == null ? null : percent(value, locale)}
		sentence={value != null ? t.answer : (absent?.sentence ?? '')}
		state={absent?.state}
		time={stamp}
		{comparison}
		{actions}
	/>
{/snippet}

<div class="overview-record grid min-w-0 gap-6">
	<ScreenTitle
		title={t.title(city)}
		subtitle={record.totals
			? `${operator}: ${countedUnit(record.totals.lines, 'line', locale)}, ${countedUnit(record.totals.stops, 'stop', locale)}`
			: undefined}
	/>
	<p class="border-t border-border pt-4">{t.intro}</p>

	<div class="grid min-w-0 gap-6" data-slot="screen-content">
		<DashboardGrid gutter={false} minTile="22rem" data-slot="screen-answer">
			<RecordCard title={t.record} {stamp}>
				{#await record.punctuality}
					{#key record.punctuality}<RecordPending {locale} answer={record.punctuality} />{/key}
					{@render actions()}
				{:then current}
					{#await record.baseline}
						{@render lead(current)}
					{:then previous}
						{@const share = overviewValue(previous, 'on_time')}
						{@const change = comparisonText(current, previous, locale)}
						{@const period = `${record.period.from === record.period.to ? t.previousWeekday : t.previous} · ${dateRange(record.previous, locale)}`}
						{@render lead(
							current,
							share == null
								? period
								: [period, percent(share, locale), change].filter(Boolean).join(' · '),
						)}
						{#if share == null}<p class="mt-2">
								<StateMark state={overviewState(previous, locale).state} {locale} />
							</p>{/if}
						{#if previous.kind === 'answer' && previous.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
					{/await}
					{#if current.kind === 'busy'}<RecordPending {locale} busy />
					{:else if current.kind !== 'answer'}<p>{recordConnection[current.kind][locale]}</p>
					{:else if current.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
				{/await}
				<dl class="mt-4 grid gap-3">
					{#await record.punctuality then current}
						{#if current.kind === 'answer' && overviewValue(current, 'on_time') != null}
							{@const { on_time, classified } = current.answer.evidence.counts}
							{#if on_time != null && classified != null}
								<div class="reading">
									<dt>{t.onTime}</dt>
									<dd>{recordRatio(on_time, countedUnit(classified, 'event', locale), locale)}</dd>
								</div>
							{/if}
						{/if}
					{/await}
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
									{#if (delivery.answer.evidence.share_eligible ?? 1) < 1}
										<p class="text-muted-foreground">
											{coverageText(delivery.answer.evidence, locale)}
										</p>
									{/if}
									{#if delivery.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
								{:else}<StateMark state={overviewState(delivery, locale).state} {locale} />{/if}
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
							{#if trend.kind === 'answer' && 'cells' in trend.answer && trend.answer.cells.length}
								<RecordPunctualityDays title={t.trend} series={trend.answer} {locale} />
							{:else}<StateMark state="not_measured" {locale} />{/if}
						{/await}
					</div>
				{/if}
				{#snippet footer()}
					<a
						class="inline-flex min-h-11 items-center text-primary underline"
						href={link('/network')}>{t.fullRecord}</a
					>
				{/snippet}
			</RecordCard>
			{#key record.manifest?.provider}
				<OverviewLiveCard {locale} manifest={record.manifest ?? null} {alertsAvailable} {link} />
			{/key}
		</DashboardGrid>

		<RecordCard title={t.rankings} {stamp}>
			<p class="mb-3 text-muted-foreground">{t.rankingIntro}</p>
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
			{/snippet}
		</RecordCard>

		{#snippet evidence(current: MeasureAnswer | null, delivery: MeasureAnswer | null)}
			{@const counts = current?.evidence.counts}
			{@const events = counts?.classified}
			{@const trips = delivery?.evidence.counts.ran}
			{@const observed = current?.evidence.share_observed}
			{@const basis = timingBasis(counts, locale)}
			<AboutFigures
				title={t.about}
				fields={[
					{ key: 'period', label: t.period, text: `${dateRange(record.period, locale)}, ${days}.` },
					{
						key: 'counted',
						label: t.counted,
						text: [
							events == null ? null : countedUnit(events, 'event', locale),
							trips == null ? null : countedUnit(trips, 'trip', locale),
							days,
							basis,
						]
							.filter(Boolean)
							.join(' · '),
					},
					{
						key: 'observed',
						label: t.observed,
						text: [
							observed == null
								? recordState('not_measured')[locale]
								: t.observedShare(percent(observed, locale)),
							current?.evidence.low_coverage ? coverageText(current.evidence, locale) : null,
							current?.coverage_note?.[locale],
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
						text: `${t.feeds(operator)} ${t.recordStart(dateRange({ from: RECORD_START, to: RECORD_START }, locale))}`,
					},
				]}
				versionsLink={{ href: link('/metrics'), label: t.method }}
			/>
		{/snippet}
		{#await record.punctuality then current}
			{#await record.delivery then delivery}
				{@render evidence(
					current.kind === 'answer' ? current.answer : null,
					delivery.kind === 'answer' ? delivery.answer : null,
				)}
			{/await}
		{/await}
	</div>
</div>

<style>
	.overview-record {
		overflow-wrap: break-word;
	}
	.reading {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 0.25em 1em;
		border-block-start: 1px solid var(--border);
		padding-block-start: 0.5em;
	}
</style>
