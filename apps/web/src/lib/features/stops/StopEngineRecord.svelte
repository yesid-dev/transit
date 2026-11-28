<script lang="ts">
	import type { Awaitable, Ready } from '#lib/site/ready.ts';
	import { untrack, type Snippet } from 'svelte';
	import './stopCards.css';
	import { page } from '$app/state';
	import FactList from '#lib/features/record/FactList.svelte';
	import { groupAlertCards, recordAlertCards } from '#lib/features/alerts/alertCards.ts';
	import NoticeRows from '#lib/features/alerts/NoticeRows.svelte';
	import FactRow from '#lib/features/record/FactRow.svelte';
	import RecordGroup from '#lib/features/record/RecordGroup.svelte';
	import type { RecordWaiting } from '#lib/features/record/recordWaiting.ts';
	import { localizeHref, type Locale } from '#lib/i18n/index.ts';
	import AboutFigures from '#lib/features/record/AboutFigures.svelte';
	import RecordActionGroup from '#lib/features/record/RecordActionGroup.svelte';
	import CiteBlock from '#lib/features/record/CiteBlock.svelte';
	import RecordAnswer from '#lib/features/record/RecordAnswer.svelte';
	import RecordCard from '#lib/features/record/RecordCard.svelte';
	import RecordEvidenceLine from '#lib/features/record/RecordEvidenceLine.svelte';
	import RecordChart from '#lib/features/record/charts/RecordChart.svelte';
	import RecordChartToggle from '#lib/features/record/charts/RecordChartToggle.svelte';
	import RecordPending from '#lib/features/record/RecordPending.svelte';
	import { providerHasAlerts } from '#lib/site/providerCapabilities.ts';
	import {
		alertsNotPublishedLine,
		alertsNotTrackedOnDates,
		officialAlertsLabel,
	} from '#lib/site/presenter.ts';
	import StateMark from '#lib/features/record/StateMark.svelte';
	import { chartState, hourGridTooFew } from '#lib/features/record/charts/recordCharts.ts';
	import { recordSectionLinks } from '#lib/features/record/recordLinks.ts';
	import {
		choose,
		measuredShare,
		rateStateText,
		recordMessage,
		tally,
		timingBasis,
	} from '#lib/features/record/recordText.ts';
	import {
		agencyName,
		dateRange,
		delayReading,
		methodEvidence,
		noPublishedNotices,
		citationSource,
		pageCitation,
		recordPercent,
		recordStamp,
	} from '#lib/site/presenter.ts';
	import type { PublicCity } from '#lib/v1/schemas/providers.ts';
	import type {
		EngineResult,
		RecordAnswer as EngineAnswer,
		RecordMeasure,
	} from '#lib/server/engine.ts';
	import type { loadStopRecord, StopSection } from '#lib/server/stopRecord.ts';
	import { carryFrameState, frameHref } from '#lib/site/frameState.ts';
	import { stopViewHref } from '#lib/site/stopFrame.ts';
	import { stopDisplayName } from '#lib/site/transitDisplay.ts';
	import { overviewCopy } from '../home/overviewRecord.copy.ts';
	import StopRecordLines from './StopRecordLines.svelte';
	import StopDelivered from './StopDelivered.svelte';
	import { stopErrorLink } from './stops.copy.ts';
	import {
		stopAccessibility,
		stopBoardingNotPublished,
		stopCitation,
		stopComparison,
		stopCoverageGap,
		stopEvidenceSample,
		stopLowCoverage,
		stopSectionTitles,
	} from './stopRecordText.ts';

	let {
		stop,
		code,
		operator,
		locale,
		url,
		record,
		heading,
		lineCount,
	}: {
		stop: { id: string; name: string };
		code?: string | null;
		operator: string;
		locale: Locale;
		url: URL;
		record: Ready<ReturnType<typeof loadStopRecord>>;
		heading: Snippet;
		lineCount: number;
	} = $props();
	const t = (en: string, fr: string) => choose(locale, en, fr);
	const term = $derived(overviewCopy[locale]);
	const provider = $derived(page.data.provider as PublicCity | undefined);
	const hasAlertFeed = $derived(providerHasAlerts(provider));
	const officialAlertsUrl = $derived(hasAlertFeed ? undefined : provider?.alert_links[locale]);
	const stopCode = $derived(code || stop.id);
	const stopLabel = $derived(t(`Stop ${stopCode}`, `Arrêt ${stopCode}`));
	const name = $derived(stop.name === stop.id ? null : stopDisplayName(stop.name));
	const subject = $derived(name ? `${stopLabel} · ${name}` : stopLabel);
	const pinned = $derived.by(() => {
		const link = stopViewHref(url, 'record');
		link.searchParams.set('provider', record.city);
		return new URL(
			frameHref(link, { mode: 'record', period: { ...record.period, preset: null } }),
			url,
		);
	});
	const link = (path: string) => carryFrameState(localizeHref(path, locale, record.city), pinned);
	const stamp = $derived({ kind: 'record' as const, label: recordStamp(record.period, locale) });
	const answers = $derived(
		Object.fromEntries(record.sections.map(({ section, answer }) => [section, answer])) as Record<
			StopSection,
			Awaitable<EngineResult<EngineAnswer>>
		>,
	);
	let content: HTMLDivElement;
	let heldHeight = $state<number>();
	let previous: { scope: string; from: string; to: string } | undefined;
	$effect.pre(() => {
		const scope = `${record.city}/${stop.id}`;
		const { from, to } = record.period;
		// Snapshot the settled scroll range before switching the existing card bodies.
		if (previous?.scope === scope && (previous.from !== from || previous.to !== to) && content)
			heldHeight = untrack(() => content.getBoundingClientRect().height);
		else if (previous?.scope !== scope) heldHeight = undefined;
		previous = { scope, from, to };
		const pending = [
			record.grid,
			record.network,
			record.networkDaily,
			record.delivery,
			...Object.values(answers),
		];
		let current = true;
		void Promise.allSettled(pending).then(() => {
			if (current) heldHeight = undefined;
		});
		return () => {
			current = false;
		};
	});
	const files = $derived(
		record.sections.map(({ section }) => ({
			href: recordSectionLinks(pinned, section).csv,
			label: t(...stopSectionTitles[section]),
		})),
	);
	const titleFor = (section: StopSection) => t(...stopSectionTitles[section]);
	const byLineShape = $derived({
		shape: 'rows',
		count: Math.min(lineCount, 12),
		lines: 1,
	} satisfies RecordWaiting);
	const waitingShape = $derived({ ...byLineShape, lines: 2 } satisfies RecordWaiting);
	const answerShape = { shape: 'answer', comparison: true } satisfies RecordWaiting;
	const noticeShape = { shape: 'notice', count: 1 } satisfies RecordWaiting;
	const bands = $derived(t('Early, on time and late', 'En avance, à l’heure et en retard'));
	const hourly = $derived(t('By hour and weekday', 'Par heure et jour de la semaine'));
	const sentence = $derived(
		t(
			'of observed stop events here were on time.',
			'des passages observés à cet arrêt étaient à l’heure.',
		),
	);
	let bandsTable = $state(false);
	let hoursTable = $state(false);
	let dailyTable = $state(false);

	function counted(answer: RecordMeasure) {
		return stopEvidenceSample(answer, 'punctuality', locale);
	}
</script>

{#snippet gap(result: EngineResult<EngineAnswer>, shape?: RecordWaiting)}
	{#if result.kind === 'busy'}<RecordPending {locale} busy {shape} />
	{:else}
		{@const answer = result.kind === 'answer' ? result.answer : null}
		{@const state = answer && 'state' in answer ? answer.state : undefined}
		{@const message = recordMessage(result, locale)}
		<p>
			<StateMark state={chartState(state)} {locale} hiddenLabel={message !== null} />
			{message ?? ''}
		</p>
	{/if}
{/snippet}

{#snippet pending(answer: Awaitable<EngineResult<EngineAnswer>>, shape?: RecordWaiting)}
	{#key answer}<RecordPending {locale} {answer} {shape} />{/key}
{/snippet}

{#snippet citation()}
	<CiteBlock
		{locale}
		text={pageCitation(
			subject,
			record.period,
			pinned.href,
			locale,
			citationSource(operator, page.data.provider, locale),
		)}
	/>
{/snippet}

{#snippet figures()}
	{#each record.sections as { section, answer } (section)}
		{#await answer then result}
			{#if result.kind === 'answer'}
				<CiteBlock
					{locale}
					text={stopCitation(
						subject,
						section,
						result.answer,
						locale,
						recordSectionLinks(pinned, section).share,
						result.lastGood,
					)}
				/>
			{/if}
		{/await}
	{/each}
{/snippet}

{#snippet about(answer: RecordMeasure | null)}
	{@const sample = answer ? counted(answer) : ''}
	<AboutFigures
		title={term.about}
		fields={[
			{ key: 'period', label: term.period, text: dateRange(record.period, locale) },
			{
				key: 'counted',
				label: term.counted,
				text: answer && sample ? `${sample}.` : null,
			},
			{
				key: 'observed',
				label: term.observed,
				text: answer
					? [
							answer.evidence.share_observed == null
								? null
								: term.observedShare(
										recordPercent(answer.evidence.share_observed, locale),
										answer.evidence.counts.scheduled == null
											? undefined
											: tally(answer.evidence.counts.scheduled, locale),
									),
							timingBasis(answer.evidence.counts, locale),
							answer.evidence.coverage_reason === 'insufficient_coverage'
								? null
								: answer.coverage_note?.[locale],
						]
							.filter(Boolean)
							.join(' ')
					: null,
			},
			{ key: 'means', label: term.means, text: term.definition },
			{
				key: 'method',
				label: term.methodRow,
				text: null,
				links: [
					{ href: link('/metrics'), label: term.method },
					{ href: link('/metrics#about-transit'), label: stopErrorLink[locale].label },
				],
			},
			{
				key: 'source',
				label: term.source,
				text: term.feeds(agencyName(operator, page.data.provider)),
			},
		]}
	/>
{/snippet}

{#snippet evidenceFooter(section: StopSection)}
	{#await section === 'hourly' ? record.grid : answers[section] then result}
		{#if result.kind === 'answer' && ('value' in result.answer || 'cells' in result.answer) && !stopLowCoverage(result)}
			{@const sample = stopEvidenceSample(result.answer, section, locale)}
			{@const versions =
				result.answer.evidence.method_version.trim() ||
				result.answer.evidence.cleaning_versions.length
					? methodEvidence(result.answer.evidence, locale, true)
					: null}
			<RecordEvidenceLine {locale} {sample} versions={versions ?? ''} />
		{/if}
	{/await}
{/snippet}

{#snippet bandsCard(result?: EngineResult<EngineAnswer>)}
	<RecordCard
		interactive={result?.kind === 'answer' &&
			'value' in result.answer &&
			result.answer.state === 'measured'}
		title={bands}
		{stamp}
		reserve="bands"
	>
		{#if result === undefined}
			{@render pending(answers.punctuality, 'bands')}
		{:else}
			{#if result.kind === 'answer' && 'value' in result.answer && result.answer.state === 'measured'}
				<RecordChart
					title={bands}
					input={{ kind: 'bands', answer: result.answer }}
					{locale}
					id="stop-bands-chart"
					table={bandsTable}
				/>
				<p class="mt-3 text-small text-muted-foreground">
					{t(
						'Early is more than 1 minute ahead of the timetable. Late is more than 5 minutes behind it.',
						'En avance signifie plus d’une minute avant l’heure prévue. En retard signifie plus de 5 minutes après l’heure prévue.',
					)}
				</p>
			{:else if stopLowCoverage(result)}
				<!-- The card keeps its place: the state and its reason, once, with no empty chart. -->
				<p>
					<StateMark state="not_measured" {locale} />
					{t(
						'Too few stop events were observed here to split them into early, on time and late.',
						'Trop peu de passages ont été observés ici pour les répartir entre en avance, à l’heure et en retard.',
					)}
				</p>
			{:else}{@render gap(result, 'bands')}{/if}
		{/if}
		{#snippet evidence()}
			{@render evidenceFooter('punctuality')}
		{/snippet}
		{#snippet toggle()}
			{#if result?.kind === 'answer' && 'value' in result.answer && result.answer.state === 'measured'}
				<RecordChartToggle bind:table={bandsTable} controls="stop-bands-chart" {locale} />
			{/if}
		{/snippet}
	</RecordCard>
{/snippet}

<div
	bind:this={content}
	class="stop-cards stop-record min-w-0"
	data-slot="screen-content"
	style:min-block-size={heldHeight === undefined ? undefined : `${heldHeight}px`}
>
	<RecordGroup class="gap-[var(--space-card-gap)]">
		<div data-screen-intro>{@render heading()}</div>
		<div id="punctuality" class="stop-record-answer" data-slot="screen-answer">
			<span id="stop-rel-pane" class="absolute" aria-hidden="true"></span>
			{#await answers.punctuality}
				{@render pending(answers.punctuality, answerShape)}
			{:then result}
				{#if result.kind === 'answer' && 'value' in result.answer}
					{@const data = result.answer}
					{@const share = measuredShare(data, 'on_time')}
					{@const reading =
						share !== null
							? sentence
							: stopLowCoverage(result)
								? (stopCoverageGap(
										data,
										locale,
										false,
										(data.info?.find(({ id }) => id === 'on_time') ?? data.info?.[0])
											?.minimum_coverage,
									) ?? rateStateText(data, locale))
								: rateStateText(data, locale)}
					{@const evidence = {
						sample: counted(data),
						record: data.evidence,
						lastGood: result.lastGood,
					}}
					{#snippet comparisonActions()}
						<RecordActionGroup {locale} href={pinned.href} {files} {citation} {figures} />
					{/snippet}
					{#await record.network}
						<RecordAnswer
							value={share === null ? null : recordPercent(share, locale)}
							sentence={reading}
							state={chartState(data.state)}
							time={stamp}
							{locale}
							{evidence}
							actions={comparisonActions}
						/>
					{:then network}
						<RecordAnswer
							value={share === null ? null : recordPercent(share, locale)}
							sentence={reading}
							state={chartState(data.state)}
							time={stamp}
							{locale}
							{evidence}
							actions={comparisonActions}
							comparison={stopComparison(data, network, locale)}
						/>
					{/await}
				{:else}
					{@render gap(result, answerShape)}
				{/if}
			{/await}
		</div>

		<div
			class="stop-timing-cards grid items-start gap-[var(--space-card-gap)] [grid-template-columns:repeat(auto-fit,minmax(min(100%,20rem),1fr))]"
		>
			{#await answers.punctuality}
				{@render bandsCard()}
			{:then result}
				{@render bandsCard(result)}
			{/await}
			<RecordCard title={titleFor('delay')} {stamp} reserve="facts">
				{#snippet evidence()}
					{@render evidenceFooter('delay')}
				{/snippet}
				<div id="delay" class="grid gap-4">
					<span id="stop-rel-percentiles" class="absolute" aria-hidden="true"></span>
					{#snippet delayFacts(measure?: RecordMeasure)}
						<FactList leading={false}>
							{#if measure}
								<FactRow
									label={t('Median delay', 'Retard médian')}
									emphasis
									detail={t(
										'Half of the vehicles were later than this.',
										'La moitié des véhicules sont passés plus tard.',
									)}
								>
									{delayReading(measure.value.median_delay, locale)}
								</FactRow>
								<FactRow
									label={t('Latest 1 in 10', 'Le dixième le plus en retard')}
									emphasis
									detail={t(
										'1 vehicle in 10 was later than this.',
										'1 véhicule sur 10 est passé plus tard.',
									)}
								>
									{delayReading(measure.value.p90_delay, locale)}
								</FactRow>
							{/if}
							{#await answers.accessibility}
								<FactRow id="accessibility" label={titleFor('accessibility')}>
									{@render pending(answers.accessibility)}
								</FactRow>
							{:then result}
								{#if result.kind === 'answer' && 'value' in result.answer}
									{@const notPublished = stopBoardingNotPublished(result.answer)}
									<FactRow
										id="accessibility"
										label={titleFor('accessibility')}
										detail={notPublished
											? t(
													'The agency does not declare it for this stop.',
													'La société de transport ne le déclare pas pour cet arrêt.',
												)
											: undefined}
									>
										{#if notPublished}
											<StateMark state="not_published" {locale} />
										{:else}
											{stopAccessibility(result.answer, locale)}
										{/if}
									</FactRow>
								{:else}
									<FactRow id="accessibility" label={titleFor('accessibility')}>
										{@render gap(result)}
									</FactRow>
								{/if}
							{/await}
						</FactList>
					{/snippet}
					{#await answers.delay}
						{@render pending(answers.delay, 'facts')}
					{:then result}
						{#if result.kind === 'answer' && 'value' in result.answer && result.answer.state === 'measured'}
							{@render delayFacts(result.answer)}
						{:else}
							{#if !stopLowCoverage(result)}{@render gap(result, 'facts')}{/if}
							{@render delayFacts()}
						{/if}
					{/await}
				</div>
			</RecordCard>
		</div>
	</RecordGroup>
	<RecordGroup class="gap-[var(--space-card-gap)]">
		<div id="byLine" class="min-w-0">
			<span id="stop-rel-by-route" class="absolute" aria-hidden="true"></span>
			{#snippet byLineCard(result?: EngineResult<EngineAnswer>)}
				<RecordCard
					interactive={result?.kind === 'answer' &&
						'cells' in result.answer &&
						result.answer.cells.some(
							(cell) => typeof cell.key.line === 'string' && cell.state !== 'no_frequent_periods',
						)}
					title={titleFor('byLine')}
					{stamp}
					reserve={byLineShape}
				>
					{#snippet evidence()}
						{@render evidenceFooter('byLine')}
					{/snippet}
					{#if result === undefined}
						{@render pending(answers.byLine, byLineShape)}
					{:else}
						{#if result.kind === 'answer' && 'cells' in result.answer && result.answer.cells.length}
							<StopRecordLines
								series={result.answer}
								{locale}
								city={record.city}
								{pinned}
								title={titleFor('byLine')}
							/>
						{:else}{@render gap(result, byLineShape)}{/if}
					{/if}
				</RecordCard>
			{/snippet}
			{#await answers.byLine}
				{@render byLineCard()}
			{:then result}
				{@render byLineCard(result)}
			{/await}
		</div>

		<div id="hourly">
			<span id="stop-rel-habits" class="absolute" aria-hidden="true"></span>
			<span id="stop-rel-weekday" class="absolute" aria-hidden="true"></span>
			<span id="stop-rel-time" class="absolute" aria-hidden="true"></span>
			{#snippet hourlyCard(result?: EngineResult<EngineAnswer>)}
				{@const chart =
					result?.kind === 'answer' &&
					'cells' in result.answer &&
					result.answer.cells.length > 0 &&
					!hourGridTooFew(result.answer)}
				{@const reserveGrid = result === undefined || result.kind === 'busy' || chart}
				<div data-grid-space={reserveGrid ? '' : undefined}>
					<RecordCard
						interactive={chart}
						title={hourly}
						{stamp}
						reserve={reserveGrid ? 'grid' : undefined}
					>
						{#if result === undefined}
							{@render pending(record.grid, 'grid')}
						{:else}
							{#if result.kind === 'answer' && 'cells' in result.answer && result.answer.cells.length}
								<RecordChart
									title={hourly}
									input={{ kind: 'hours', answer: result.answer }}
									{locale}
									id="stop-hours-chart"
									table={hoursTable}
								/>
							{:else}{@render gap(result, 'grid')}{/if}
						{/if}
						{#snippet evidence()}
							{@render evidenceFooter('hourly')}
						{/snippet}
						{#snippet toggle()}
							{#if result?.kind === 'answer' && 'cells' in result.answer && result.answer.cells.length && !hourGridTooFew(result.answer)}
								<RecordChartToggle bind:table={hoursTable} controls="stop-hours-chart" {locale} />
							{/if}
						{/snippet}
					</RecordCard>
				</div>
			{/snippet}
			{#await record.grid}
				{@render hourlyCard()}
			{:then result}
				{@render hourlyCard(result)}
			{/await}
		</div>

		<div id="waiting">
			<span id="stop-schedule-service" class="absolute" aria-hidden="true"></span>
			{#snippet waitingCard(result?: EngineResult<EngineAnswer>)}
				<RecordCard
					interactive={result?.kind === 'answer' &&
						'cells' in result.answer &&
						result.answer.cells.length > 0}
					title={titleFor('waiting')}
					{stamp}
					reserve={waitingShape}
				>
					{#snippet evidence()}
						{@render evidenceFooter('waiting')}
					{/snippet}
					{#if result === undefined}
						{@render pending(answers.waiting, waitingShape)}
					{:else}
						{#if result.kind === 'answer' && 'cells' in result.answer && result.answer.cells.length}
							<StopRecordLines
								series={result.answer}
								{locale}
								city={record.city}
								{pinned}
								title={titleFor('waiting')}
								waiting
							/>
						{:else}{@render gap(result, waitingShape)}{/if}
					{/if}
				</RecordCard>
			{/snippet}
			{#await answers.waiting}
				{@render waitingCard()}
			{:then result}
				{@render waitingCard(result)}
			{/await}
		</div>

		<div
			class="grid min-w-0 items-start gap-[var(--space-card-gap)] xl:grid-cols-[minmax(0,6fr)_minmax(0,5fr)]"
		>
			<div id="daily" class="min-w-0">
				<span id="stop-rel-trend" class="absolute" aria-hidden="true"></span>
				{#snippet dailyCard(result?: EngineResult<EngineAnswer>)}
					<RecordCard
						interactive={result?.kind === 'answer' &&
							'cells' in result.answer &&
							result.answer.cells.length > 0}
						title={titleFor('daily')}
						{stamp}
						reserve="trend"
					>
						{#if result === undefined}
							{@render pending(answers.daily, 'trend')}
						{:else}
							{#if result.kind === 'answer' && 'cells' in result.answer && result.answer.cells.length}
								{#await record.networkDaily}
									<RecordChart
										title={titleFor('daily')}
										id="stop-daily-chart"
										table={dailyTable}
										input={{ kind: 'trend', answer: result.answer, stop: true }}
										{locale}
									/>
								{:then network}
									<RecordChart
										title={titleFor('daily')}
										id="stop-daily-chart"
										table={dailyTable}
										input={{
											kind: 'trend',
											answer: result.answer,
											stop: true,
											network:
												network.kind === 'answer' && 'cells' in network.answer
													? network.answer
													: undefined,
										}}
										{locale}
									/>
								{/await}
							{:else}{@render gap(result, 'trend')}{/if}
						{/if}
						{#snippet evidence()}
							{@render evidenceFooter('daily')}
						{/snippet}
						{#snippet toggle()}
							{#if result?.kind === 'answer' && 'cells' in result.answer && result.answer.cells.length}
								<RecordChartToggle bind:table={dailyTable} controls="stop-daily-chart" {locale} />
							{/if}
						{/snippet}
					</RecordCard>
				{/snippet}
				{#await answers.daily}
					{@render dailyCard()}
				{:then result}
					{@render dailyCard(result)}
				{/await}
			</div>
			<StopDelivered {locale} {stamp} answer={record.delivery} />
		</div>

		<div id="alerts">
			<RecordCard title={titleFor('alerts')} {stamp} interactive={!!officialAlertsUrl}>
				{#snippet evidence()}
					{@render evidenceFooter('alerts')}
				{/snippet}
				{#if !hasAlertFeed}
					<p>
						{alertsNotPublishedLine(
							agencyName(operator, provider),
							locale,
							Boolean(officialAlertsUrl),
						)}
					</p>
				{:else}
					{#await answers.alerts}
						{@render pending(answers.alerts, noticeShape)}
					{:then result}
						{#if result.kind === 'answer' && 'value' in result.answer && result.answer.state === 'measured'}
							{@const count = result.answer.value.alerts}
							{@const notices = groupAlertCards(
								recordAlertCards(result.answer.evidence.alert_messages).filter((notice) =>
									notice.stops.includes(stop.id),
								),
							)}
							{#if count === 0}
								<p>
									{noPublishedNotices(
										agencyName(operator, provider),
										'stop',
										locale,
										!result.answer.evidence.days_not_measured.length &&
											!result.answer.evidence.days_not_tracked?.length,
									)}
								</p>
							{:else if notices.length}
								<NoticeRows
									cards={notices}
									{locale}
									timeZone={provider?.timezone}
									stopName={(id) => (id === stop.id ? (name ?? stopCode) : id)}
								/>
							{:else if count != null}
								<FactList leading={false}>
									<FactRow label={t('Distinct notices', 'Avis distincts')}
										>{tally(count, locale)}</FactRow
									>
								</FactList>
							{:else}
								<StateMark state="unknown" {locale} />
							{/if}
						{:else if result.kind === 'answer' && 'state' in result.answer && result.answer.state === 'not_tracked'}
							<p>{alertsNotTrackedOnDates(agencyName(operator, provider), locale)}</p>
						{:else}{@render gap(result, noticeShape)}{/if}
					{/await}
				{/if}
				{#snippet links()}
					{#if officialAlertsUrl}
						<a
							class="inline-flex min-h-11 items-center text-primary underline"
							href={officialAlertsUrl}>{officialAlertsLabel(locale)}</a
						>
					{/if}
				{/snippet}
			</RecordCard>
		</div>
	</RecordGroup>
	<RecordGroup class="gap-[var(--space-card-gap)]">
		<div id="stop-rel-source">
			<span id="stop-rel-crowding" class="absolute" aria-hidden="true"></span>
			{#await answers.punctuality}
				{@render about(null)}
			{:then result}
				{@render about(result.kind === 'answer' && 'value' in result.answer ? result.answer : null)}
			{/await}
		</div>
	</RecordGroup>
</div>
