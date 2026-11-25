<script lang="ts">
	import FactList from '#lib/features/record/FactList.svelte';
	import FactRow from '#lib/features/record/FactRow.svelte';
	import RecordScreen from '#lib/features/record/RecordScreen.svelte';
	import RecordGroup from '#lib/features/record/RecordGroup.svelte';
	import { DashboardGrid, Surface } from '@yesid/ui/layout';
	import { localizeHref, type Locale } from '#lib/i18n/index.ts';
	import AboutFigures from '#lib/features/record/AboutFigures.svelte';
	import RecordActionGroup from '#lib/features/record/RecordActionGroup.svelte';
	import RecordAnswer from '#lib/features/record/RecordAnswer.svelte';
	import RecordCard from '#lib/features/record/RecordCard.svelte';
	import RecordEvidenceLine from '#lib/features/record/RecordEvidenceLine.svelte';
	import RecordChart from '#lib/features/record/charts/RecordChart.svelte';
	import RecordChartToggle from '#lib/features/record/charts/RecordChartToggle.svelte';
	import RecordPending from '#lib/features/record/RecordPending.svelte';
	import ScreenTitle from '#lib/features/record/ScreenTitle.svelte';
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
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { stopDisplayName } from '#lib/site/transitDisplay.ts';
	import type { IdentitySeed } from '#lib/v1/serverContext.ts';
	import { overviewCopy } from '../home/overviewRecord.copy.ts';
	import StopRecordLines from './StopRecordLines.svelte';
	import {
		stopAccessibility,
		stopCitation,
		stopComparison,
		stopEvidenceSample,
		stopSectionTitles,
	} from './stopRecordText.ts';

	let {
		stop,
		code,
		lines,
		operator,
		locale,
		url,
		record,
	}: {
		stop: IdentitySeed;
		code?: string | null;
		lines?: readonly string[];
		operator: string;
		locale: Locale;
		url: URL;
		record: ReturnType<typeof loadStopRecord>;
	} = $props();
	const display = transitDisplay();
	const t = (en: string, fr: string) => choose(locale, en, fr);
	const term = $derived(overviewCopy[locale]);
	const stopCode = $derived(code || stop.id);
	const stopLabel = $derived(t(`Stop ${stopCode}`, `Arrêt ${stopCode}`));
	const name = $derived(stop.name === stop.id ? null : stopDisplayName(stop.name));
	const subject = $derived(name ? `${stopLabel} · ${name}` : stopLabel);
	const lineList = $derived(lines?.length ? lines.map(display.line).join(', ') : null);
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
							answer.coverage_note?.[locale],
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

<Surface>
	<RecordScreen>
		<RecordGroup>
			<ScreenTitle
				title={name ?? stopLabel}
				stopCode={name ? stopCode : undefined}
				subtitle={lineList
					? t(
							`${stopLabel}, ${lines?.length === 1 ? 'line' : 'lines'} ${lineList}`,
							`${stopLabel}, ${lines?.length === 1 ? 'ligne' : 'lignes'} ${lineList}`,
						)
					: name
						? stopLabel
						: undefined}
				back={{ href: link('/stops'), label: t('All stops', 'Tous les arrêts') }}
			/>
		</RecordGroup>
		<div class="min-w-0" data-slot="screen-content">
			<RecordGroup>
				<div id="punctuality" data-slot="screen-answer">
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
									sentence={share === null ? rateStateText(data, locale) : sentence}
									state={chartState(data.state)}
									time={stamp}
									{locale}
									{evidence}
									actions={comparisonActions}
								/>
							{:then network}
								<RecordAnswer
									value={share === null ? null : percent(share, locale)}
									sentence={share === null ? rateStateText(data, locale) : sentence}
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
					<RecordCard interactive title={bands} {stamp}>
						{#await answers.punctuality}
							{@render pending(answers.punctuality)}
						{:then result}
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
							{:else}{@render gap(result)}{/if}
						{/await}
						{#snippet evidence()}
							{@render evidenceFooter('punctuality')}
						{/snippet}
						{#snippet toggle()}
							{#await answers.punctuality then result}
								{#if result.kind === 'answer' && 'value' in result.answer && result.answer.state === 'measured'}
									<RecordChartToggle bind:table={bandsTable} controls="stop-bands-chart" {locale} />
								{/if}
							{/await}
						{/snippet}
					</RecordCard>
					<RecordCard title={titleFor('delay')} {stamp}>
						{#snippet evidence()}
							{@render evidenceFooter('delay')}
						{/snippet}
						<div id="delay" class="grid gap-4">
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
											{@const notPublished =
												result.answer.evidence.counts.stops_no_information === 1 ||
												result.answer.state === 'not_published'}
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
													{t('Not published', 'Non publié')}
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
									{@render gap(result)}
									{@render delayFacts()}
								{/if}
							{/await}
						</div>
					</RecordCard>
				</DashboardGrid>
			</RecordGroup>
			<RecordGroup>
				<div id="byLine" class="min-w-0">
					<RecordCard interactive title={titleFor('byLine')} {stamp}>
						{#snippet evidence()}
							{@render evidenceFooter('byLine')}
						{/snippet}
						{#await answers.byLine}
							{@render pending(answers.byLine)}
						{:then result}
							{#if result.kind === 'answer' && 'cells' in result.answer && result.answer.cells.length}
								<StopRecordLines
									series={result.answer}
									{locale}
									city={record.city}
									{pinned}
									title={titleFor('byLine')}
								/>
							{:else}{@render gap(result)}{/if}
						{/await}
					</RecordCard>
				</div>

				<div id="hourly">
					<RecordCard interactive title={hourly} {stamp}>
						{#await record.grid}
							{@render pending(record.grid)}
						{:then result}
							{#if result.kind === 'answer' && 'cells' in result.answer && result.answer.cells.length}
								<RecordChart
									title={hourly}
									input={{ kind: 'hours', answer: result.answer }}
									{locale}
									id="stop-hours-chart"
									table={hoursTable}
								/>
							{:else}{@render gap(result)}{/if}
						{/await}
						{#snippet evidence()}
							{@render evidenceFooter('hourly')}
						{/snippet}
						{#snippet toggle()}
							{#await record.grid then result}
								{#if result.kind === 'answer' && 'cells' in result.answer && result.answer.cells.length}
									<RecordChartToggle bind:table={hoursTable} controls="stop-hours-chart" {locale} />
								{/if}
							{/await}
						{/snippet}
					</RecordCard>
				</div>

				<div id="waiting">
					<RecordCard interactive title={titleFor('waiting')} {stamp}>
						{#snippet evidence()}
							{@render evidenceFooter('waiting')}
						{/snippet}
						{#await answers.waiting}
							{@render pending(answers.waiting)}
						{:then result}
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
						{/await}
					</RecordCard>
				</div>

				<div id="daily">
					<RecordCard interactive title={titleFor('daily')} {stamp}>
						{#await answers.daily}
							{@render pending(answers.daily)}
						{:then result}
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
						{/await}
						{#snippet evidence()}
							{@render evidenceFooter('daily')}
						{/snippet}
						{#snippet toggle()}
							{#await answers.daily then result}
								{#if result.kind === 'answer' && 'cells' in result.answer && result.answer.cells.length}
									<RecordChartToggle bind:table={dailyTable} controls="stop-daily-chart" {locale} />
								{/if}
							{/await}
						{/snippet}
					</RecordCard>
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
					{@render about(
						result.kind === 'answer' && 'value' in result.answer ? result.answer : null,
					)}
				{/await}
			</RecordGroup>
		</div>
	</RecordScreen>
</Surface>
