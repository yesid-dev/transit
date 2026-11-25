<script lang="ts">
	import FactList from '#lib/features/record/FactList.svelte';
	import FactRow from '#lib/features/record/FactRow.svelte';
	import RecordGroup from '#lib/features/record/RecordGroup.svelte';
	import { DashboardGrid } from '@yesid/ui/layout';
	import { localizeHref, type Locale } from '#lib/i18n/index.ts';
	import AboutFigures from '#lib/features/record/AboutFigures.svelte';
	import RecordActionGroup from '#lib/features/record/RecordActionGroup.svelte';
	import RecordAnswer from '#lib/features/record/RecordAnswer.svelte';
	import RecordCard from '#lib/features/record/RecordCard.svelte';
	import RecordEvidenceLine from '#lib/features/record/RecordEvidenceLine.svelte';
	import RecordChart from '#lib/features/record/charts/RecordChart.svelte';
	import RecordChartToggle from '#lib/features/record/charts/RecordChartToggle.svelte';
	import RecordPending from '#lib/features/record/RecordPending.svelte';
	import StateMark from '#lib/features/record/StateMark.svelte';
	import { chartState } from '#lib/features/record/charts/recordCharts.ts';
	import { recordSectionLinks } from '#lib/features/record/recordLinks.ts';
	import {
		choose,
		measuredShare,
		percent,
		pooledDays,
		punctualityWeighting,
		rateStateText,
		recordMessage,
		tally,
		timingBasis,
	} from '#lib/features/record/recordText.ts';
	import { dateRange, delayReading, methodEvidence, recordStamp } from '#lib/site/presenter.ts';
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
	import {
		stopAccessibility,
		stopBoardingNotPublished,
		stopCitation,
		stopComparison,
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
	}: {
		stop: { id: string; name: string };
		code?: string | null;
		operator: string;
		locale: Locale;
		url: URL;
		record: ReturnType<typeof loadStopRecord>;
	} = $props();
	const t = (en: string, fr: string) => choose(locale, en, fr);
	const term = $derived(overviewCopy[locale]);
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
			Promise<EngineResult<EngineAnswer>>
		>,
	);
	const files = $derived(
		record.sections.map(({ section }) => ({
			href: recordSectionLinks(pinned, section).csv,
			label: t(...stopSectionTitles[section]),
		})),
	);
	const titleFor = (section: StopSection) => t(...stopSectionTitles[section]);
	const bands = $derived(t('Early, on time and late', 'En avance, à l’heure et en retard'));
	const hourly = $derived(t('By hour and weekday', 'Par heure et jour de la semaine'));
	const sentence = $derived(
		t(
			'of observed stop events here were on time.',
			'des passages observés à cet arrêt étaient à l’heure.',
		),
	);
	const insufficientCoverage = $derived(
		t(
			'There are too few observed stop events to measure punctuality for these dates.',
			'Il y a trop peu de passages observés pour mesurer la ponctualité à ces dates.',
		),
	);
	let bandsTable = $state(false);
	let hoursTable = $state(false);
	let dailyTable = $state(false);

	function counted(answer: RecordMeasure) {
		return stopEvidenceSample(answer, 'punctuality', locale);
	}
</script>

{#snippet gap(result: EngineResult<EngineAnswer>, quiet = true)}
	{#if result.kind === 'busy'}<RecordPending {locale} busy />
	{:else}
		{@const answer = result.kind === 'answer' ? result.answer : null}
		{@const state = answer && 'state' in answer ? answer.state : undefined}
		{@const message =
			quiet && result.kind !== 'answer' ? term.unavailable : recordMessage(result, locale)}
		<p>
			<StateMark state={chartState(state)} {locale} hiddenLabel={message !== null} />
			{message ?? ''}
		</p>
	{/if}
{/snippet}

{#snippet pending(answer: Promise<EngineResult<EngineAnswer>>)}
	{#key answer}<RecordPending {locale} {answer} />{/key}
{/snippet}

{#snippet citation()}
	{#each record.sections as { section, answer } (section)}
		{#await answer then result}
			{#if result.kind === 'answer'}
				<p>
					{stopCitation(
						subject,
						section,
						result.answer,
						locale,
						recordSectionLinks(pinned, section).share,
						result.lastGood,
					)}
				</p>
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
				text: answer
					? [
							sample ? `${sample}.` : null,
							punctualityWeighting[locale],
							record.period.from === record.period.to ? null : pooledDays[locale],
						]
							.filter(Boolean)
							.join(' ')
					: null,
			},
			{
				key: 'observed',
				label: term.observed,
				text: answer
					? [
							answer.evidence.share_observed == null
								? null
								: term.observedShare(
										percent(answer.evidence.share_observed, locale),
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
				key: 'versions',
				label: term.versions,
				text: answer ? methodEvidence(answer.evidence, locale) : null,
			},
			{
				key: 'source',
				label: term.source,
				text: term.feeds(operator),
			},
		]}
		versionsLink={{ href: link('/metrics'), label: term.method }}
	/>
{/snippet}

{#snippet evidenceFooter(section: StopSection)}
	{#await section === 'hourly' ? record.grid : answers[section] then result}
		{#if result.kind === 'answer' && ('value' in result.answer || 'cells' in result.answer)}
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
	>
		{#if result === undefined}
			{@render pending(answers.punctuality)}
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
						'En avance signifie plus de 1 minute avant l’heure prévue. En retard signifie plus de 5 minutes après l’heure prévue.',
					)}
				</p>
			{:else if !stopLowCoverage(result)}{@render gap(result)}{/if}
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

<div class="min-w-0" data-slot="screen-content">
	<RecordGroup>
		<div id="punctuality" data-slot="screen-answer">
			<span id="stop-rel-pane" class="absolute" aria-hidden="true"></span>
			{#await answers.punctuality}
				{@render pending(answers.punctuality)}
			{:then result}
				{#if result.kind === 'answer' && 'value' in result.answer}
					{@const data = result.answer}
					{@const share = measuredShare(data, 'on_time')}
					{@const evidence = {
						sample: counted(data),
						record: data.evidence,
						lastGood: result.lastGood,
					}}
					{#snippet comparisonActions()}
						<RecordActionGroup {locale} href={pinned.href} {files} {citation} />
					{/snippet}
					{#await record.network}
						<RecordAnswer
							value={share === null ? null : percent(share, locale)}
							sentence={share === null
								? stopLowCoverage(result)
									? insufficientCoverage
									: rateStateText(data, locale)
								: sentence}
							state={chartState(data.state)}
							time={stamp}
							{locale}
							{evidence}
							actions={comparisonActions}
						/>
					{:then network}
						<RecordAnswer
							value={share === null ? null : percent(share, locale)}
							sentence={share === null
								? stopLowCoverage(result)
									? insufficientCoverage
									: rateStateText(data, locale)
								: sentence}
							state={chartState(data.state)}
							time={stamp}
							{locale}
							{evidence}
							actions={comparisonActions}
							comparison={stopComparison(data, network, locale)}
						/>
					{/await}
				{:else}
					{@render gap(result, false)}
				{/if}
			{/await}
		</div>

		<DashboardGrid gutter={false} minTile="20rem">
			{#await answers.punctuality}
				{@render bandsCard()}
			{:then result}
				{@render bandsCard(result)}
			{/await}
			<RecordCard title={titleFor('delay')} {stamp}>
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
									label={t('90th percentile', '90e centile')}
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
													'L’exploitant ne le déclare pas pour cet arrêt.',
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
						{@render pending(answers.delay)}
						{@render delayFacts()}
					{:then result}
						{#if result.kind === 'answer' && 'value' in result.answer && result.answer.state === 'measured'}
							{@render delayFacts(result.answer)}
						{:else}
							{#if !stopLowCoverage(result)}{@render gap(result)}{/if}
							{@render delayFacts()}
						{/if}
					{/await}
				</div>
			</RecordCard>
		</DashboardGrid>
	</RecordGroup>
	<RecordGroup>
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
				>
					{#snippet evidence()}
						{@render evidenceFooter('byLine')}
					{/snippet}
					{#if result === undefined}
						{@render pending(answers.byLine)}
					{:else}
						{#if result.kind === 'answer' && 'cells' in result.answer && result.answer.cells.length}
							<StopRecordLines
								series={result.answer}
								{locale}
								city={record.city}
								{pinned}
								title={titleFor('byLine')}
							/>
						{:else}{@render gap(result)}{/if}
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
				<RecordCard
					interactive={result?.kind === 'answer' &&
						'cells' in result.answer &&
						result.answer.cells.length > 0}
					title={hourly}
					{stamp}
				>
					{#if result === undefined}
						{@render pending(record.grid)}
					{:else}
						{#if result.kind === 'answer' && 'cells' in result.answer && result.answer.cells.length}
							<RecordChart
								title={hourly}
								input={{ kind: 'hours', answer: result.answer }}
								{locale}
								id="stop-hours-chart"
								table={hoursTable}
							/>
						{:else}{@render gap(result)}{/if}
					{/if}
					{#snippet evidence()}
						{@render evidenceFooter('hourly')}
					{/snippet}
					{#snippet toggle()}
						{#if result?.kind === 'answer' && 'cells' in result.answer && result.answer.cells.length}
							<RecordChartToggle bind:table={hoursTable} controls="stop-hours-chart" {locale} />
						{/if}
					{/snippet}
				</RecordCard>
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
				>
					{#snippet evidence()}
						{@render evidenceFooter('waiting')}
					{/snippet}
					{#if result === undefined}
						{@render pending(answers.waiting)}
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
						{:else}{@render gap(result)}{/if}
					{/if}
				</RecordCard>
			{/snippet}
			{#await answers.waiting}
				{@render waitingCard()}
			{:then result}
				{@render waitingCard(result)}
			{/await}
		</div>

		<div id="daily">
			<span id="stop-rel-trend" class="absolute" aria-hidden="true"></span>
			{#snippet dailyCard(result?: EngineResult<EngineAnswer>)}
				<RecordCard
					interactive={result?.kind === 'answer' &&
						'cells' in result.answer &&
						result.answer.cells.length > 0}
					title={titleFor('daily')}
					{stamp}
				>
					{#if result === undefined}
						{@render pending(answers.daily)}
					{:else}
						{#if result.kind === 'answer' && 'cells' in result.answer && result.answer.cells.length}
							{#await record.networkDaily}
								<RecordChart
									title={titleFor('daily')}
									id="stop-daily-chart"
									table={dailyTable}
									input={{ kind: 'trend', answer: result.answer }}
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
										network:
											network.kind === 'answer' && 'cells' in network.answer
												? network.answer
												: undefined,
									}}
									{locale}
								/>
							{/await}
						{:else}{@render gap(result)}{/if}
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

		<div id="alerts">
			<RecordCard title={titleFor('alerts')} {stamp}>
				{#snippet evidence()}
					{@render evidenceFooter('alerts')}
				{/snippet}
				{#await answers.alerts}
					{@render pending(answers.alerts)}
				{:then result}
					{#if result.kind === 'answer' && 'value' in result.answer && result.answer.state === 'measured'}
						<FactList leading={false}>
							<FactRow label={t('Distinct alerts', 'Avis distincts')}>
								{result.answer.value.alerts == null
									? t('Unknown', 'Inconnu')
									: tally(result.answer.value.alerts, locale)}
							</FactRow>
							<FactRow label={t('Versions of those alerts', 'Versions de ces avis')}>
								{result.answer.value.alert_versions == null
									? t('Unknown', 'Inconnu')
									: tally(result.answer.value.alert_versions, locale)}
							</FactRow>
						</FactList>
					{:else}{@render gap(result)}{/if}
				{/await}
			</RecordCard>
		</div>
	</RecordGroup>
	<RecordGroup>
		{#await answers.punctuality then result}
			<div id="stop-rel-source">
				<span id="stop-rel-crowding" class="absolute" aria-hidden="true"></span>{@render about(
					result.kind === 'answer' && 'value' in result.answer ? result.answer : null,
				)}
			</div>
		{/await}
	</RecordGroup>
</div>
