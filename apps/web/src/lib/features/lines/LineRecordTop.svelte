<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Skeleton } from '@yesid/ui/skeleton';
	import type { Ready } from '#lib/site/ready.ts';
	import FactList from '#lib/features/record/FactList.svelte';
	import FactRow from '#lib/features/record/FactRow.svelte';
	import { goto } from '$app/navigation';
	import { SegmentedChoice } from '@yesid/ui/brand';
	import { DashboardGrid } from '@yesid/ui/layout';
	import { tick } from 'svelte';
	import type { Locale } from '#lib/i18n/index.ts';
	import RecordActionGroup from '#lib/features/record/RecordActionGroup.svelte';
	import CiteBlock from '#lib/features/record/CiteBlock.svelte';
	import RecordAnswer from '#lib/features/record/RecordAnswer.svelte';
	import RecordCard from '#lib/features/record/RecordCard.svelte';
	import RecordChart from '#lib/features/record/charts/RecordChart.svelte';
	import RecordChartToggle from '#lib/features/record/charts/RecordChartToggle.svelte';
	import { chartState } from '#lib/features/record/charts/recordCharts.ts';
	import RecordPending from '#lib/features/record/RecordPending.svelte';
	import { pendingBlockSize, type RecordWaiting } from '../record/recordWaiting.ts';
	import RecordUnavailable from '#lib/features/record/RecordUnavailable.svelte';
	import StateMark from '#lib/features/record/StateMark.svelte';
	import { recordSectionLinks } from '#lib/features/record/recordLinks.ts';
	import {
		choose,
		measuredShare,
		rateStateText,
		recordMessage,
	} from '#lib/features/record/recordText.ts';
	import type { EngineResult, RecordAnswer as Answer, RecordMeasure } from '#lib/server/engine.ts';
	import type { loadLineRecord, LineSection } from '#lib/server/lineRecord.ts';
	import { page } from '$app/state';
	import {
		agencyName,
		countedUnit,
		frenchAgency,
		pageCitation,
		citationSource,
		recordPercent,
		recordStamp,
	} from '#lib/site/presenter.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { stopComparison } from '#lib/features/stops/stopRecordText.ts';
	import {
		lineCitation,
		lineSectionTitles,
		lineTimetableOnly,
		lineViewHref,
	} from './lineRecordText.ts';
	import LineRecordEvidence, { lineEvidenceSample } from './LineRecordEvidence.svelte';

	let {
		heading,
		name,
		scheduleOnly,
		timetableOnly,
		locale,
		record,
		pinned,
		headsigns,
		operator,
	}: {
		heading?: Snippet;
		name: string;
		scheduleOnly?: boolean;
		timetableOnly: boolean;
		locale: Locale;
		record: Ready<ReturnType<typeof loadLineRecord>>;
		pinned: URL;
		headsigns: Record<number, string>;
		operator: string;
	} = $props();

	const t = (en: string, fr: string) => choose(locale, en, fr);
	const agencyFr = $derived(frenchAgency(agencyName(operator, page.data.provider)));
	const { directionLabel } = transitDisplay();
	const title = (section: LineSection) => t(...lineSectionTitles[section]);
	const bands = $derived(t('Early, on time and late', 'En avance, à l’heure et en retard'));
	const stamp = $derived({ kind: 'record' as const, label: recordStamp(record.period, locale) });
	const answerFor = (section: LineSection) =>
		record.sections.find((item) => item.section === section)!.answer;
	const punctualityAnswer = $derived(answerFor('punctuality'));
	const directionsAnswer = $derived(answerFor('directions'));
	const dailyAnswer = $derived(answerFor('daily'));
	const hourlyAnswer = $derived(answerFor('hourly'));
	const comparisonShape = { shape: 'answer', comparison: true } as const;
	const chartSlots = {
		bands: pendingBlockSize('bands'),
		trend: pendingBlockSize('trend'),
		grid: pendingBlockSize('grid'),
	};
	const directionShape = { shape: 'facts', count: 2 } as const;
	const networkAnswer = $derived(record.network);
	const networkDailyAnswer = $derived(record.networkDaily);
	const files = $derived(
		record.sections.map(({ section }) => ({
			href: recordSectionLinks(pinned, section).csv,
			label: title(section),
		})),
	);
	const options = $derived([
		{
			key: 'both' as const,
			label: t('Both directions', 'Les deux directions'),
			compactLabel: t('Both', 'Les deux'),
		},
		...(['0', '1'] as const)
			.filter((id) => headsigns[Number(id)] || record.direction === id)
			.map((key) => ({ key, label: directionLabel(key, headsigns, locale) })),
	]);
	let dailyTable = $state(false);
	let hoursTable = $state(false);
	let directionField = $state<HTMLDivElement>();

	async function selectDirection(key: 'both' | '0' | '1') {
		const direction = key === 'both' ? null : key;
		if (direction === record.direction) return;
		const wasFocused = directionField?.contains(document.activeElement);
		const target = lineViewHref(pinned, 'record', direction);
		await goto(target.pathname + target.search, { reset: false });
		// The grid remounts when the new punctuality answer resolves.
		await punctualityAnswer;
		await tick();
		if (wasFocused && record.direction === direction && document.activeElement === document.body) {
			directionField
				?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')
				?.focus({ preventScroll: true });
		}
	}
</script>

{#snippet directionControl()}
	{#if options.length > 1}
		<div class="mb-3" bind:this={directionField}>
			<SegmentedChoice
				{options}
				value={record.direction ?? 'both'}
				label={t('Filter by direction', 'Filtrer par direction')}
				variant="fit-row"
				onSelect={(key) => void selectDirection(key)}
			/>
		</div>
	{/if}
{/snippet}

{#snippet gap(result: EngineResult<Answer>, shape?: RecordWaiting)}
	{#if result.kind === 'busy'}
		<RecordPending {locale} busy {shape} />
	{:else if result.kind !== 'answer'}
		<RecordUnavailable {locale} retry={result.kind === 'unreachable' ? result.retry : undefined} />
	{:else}
		{@const answer = result.answer}
		<p>
			<StateMark
				state={chartState('state' in answer ? answer.state : undefined)}
				{locale}
				hiddenLabel
			/>
			{recordMessage(result, locale)}
		</p>
	{/if}
{/snippet}

{#snippet citation()}
	<CiteBlock
		{locale}
		text={pageCitation(
			name,
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
					text={lineCitation(
						name,
						title(section),
						result.answer,
						locale,
						recordSectionLinks(pinned, section).share,
					)}
				/>
			{/if}
		{/await}
	{/each}
{/snippet}

{#snippet actions()}
	<RecordActionGroup
		{locale}
		href={recordSectionLinks(pinned, scheduleOnly ? 'schedule' : 'punctuality').share}
		{files}
		{citation}
		{figures}
	/>
{/snippet}

{#snippet lead(answer: RecordMeasure, lastGood: boolean, comparison?: string)}
	{@const share = measuredShare(answer, 'on_time')}
	<RecordAnswer
		{heading}
		value={share === null ? null : recordPercent(share, locale)}
		sentence={share === null
			? rateStateText(answer, locale)
			: t(
					'of observed stop events on this line were on time.',
					'des passages observés aux arrêts de cette ligne étaient à l’heure.',
				)}
		state={chartState(answer.state)}
		time={stamp}
		{locale}
		evidence={{
			sample: lineEvidenceSample(answer.evidence, locale),
			lastGood,
		}}
		{actions}
		{comparison}
	/>
{/snippet}

<div
	id="punctuality"
	data-slot="screen-answer"
	class={['min-[1280px]:-mb-4', heading && 'min-[1280px]:min-h-36']}
>
	{#if scheduleOnly}
		{#snippet timetableNotice()}
			<p>
				{t(
					`${operator} publishes no realtime feed for this line. Its timetable is shown below.`,
					`${agencyFr.start} ne publie pas de flux en temps réel pour cette ligne. Son horaire est présenté ci-dessous.`,
				)}
			</p>
		{/snippet}
		<RecordAnswer
			{heading}
			value={null}
			sentence={t('No live data for this line', 'Aucune donnée en direct pour cette ligne')}
			{locale}
			state="no_live_data"
			meta={timetableNotice}
			{actions}
		/>
	{:else}
		{#await punctualityAnswer}
			{#key punctualityAnswer}<RecordPending
					{heading}
					shape={comparisonShape}
					{locale}
					answer={punctualityAnswer}
				/>{/key}
		{:then result}
			{#if result.kind === 'answer' && 'value' in result.answer}
				{@const answer = result.answer}
				{#if lineTimetableOnly(answer)}
					{#snippet reason()}<p>
							{answer.coverage_note?.[locale] ??
								t(
									'There are no usable observations for this line on these dates. Its timetable is shown below.',
									'Il n’y a pas d’observations utilisables pour cette ligne à ces dates. Son horaire est présenté ci-dessous.',
								)}
						</p>{/snippet}
					<RecordAnswer
						{heading}
						value={null}
						sentence={rateStateText(answer, locale)}
						{locale}
						state={chartState(answer.state)}
						time={stamp}
						meta={reason}
						{actions}
					/>
				{:else}
					{#await networkAnswer}
						{@render lead(answer, !!result.lastGood)}
					{:then network}
						{@render lead(
							answer,
							!!result.lastGood,
							network ? stopComparison(answer, network, locale) : undefined,
						)}
					{/await}
				{/if}
			{:else}
				{@render heading?.()}
				{@render gap(result, comparisonShape)}
			{/if}
		{/await}
	{/if}
</div>

{#if !scheduleOnly && !timetableOnly}
	<div class="paired-line-readings">
		<DashboardGrid gutter={false} minTile="20rem" class="items-start">
			<RecordCard title={bands} {stamp} stampRule>
				<div
					class="reading-body"
					style:--slot-wide={chartSlots.bands?.wide}
					style:--slot-phone={chartSlots.bands?.phone}
				>
					{#await punctualityAnswer}
						{#key punctualityAnswer}<RecordPending
								shape="bands"
								{locale}
								answer={punctualityAnswer}
							/>{/key}
					{:then result}
						{#if result.kind === 'answer' && 'value' in result.answer && result.answer.state === 'measured'}
							<RecordChart
								title={bands}
								input={{ kind: 'bands', answer: result.answer }}
								{locale}
								id="line-bands-chart"
							/>
							<p class="mt-2 text-small text-muted-foreground">
								{t(
									'Early is more than 1 minute ahead of the timetable. Late is more than 5 minutes behind it.',
									'En avance signifie plus d’une minute avant l’heure prévue. En retard signifie plus de 5 minutes après l’heure prévue.',
								)}
							</p>
						{:else}{@render gap(result, 'bands')}{/if}
					{/await}
				</div>
				<div id="directions" class="mt-3 grid gap-2">
					<h3 class="font-semibold">{title('directions')}</h3>
					{#await directionsAnswer}
						{#key directionsAnswer}<RecordPending
								shape={directionShape}
								{locale}
								answer={directionsAnswer}
							/>{/key}
					{:then result}
						{@const cells =
							result.kind === 'answer' && 'cells' in result.answer
								? result.answer.cells.filter(
										(cell) =>
											// An unknown direction with nothing observed is no reading.
											!(
												(cell.key.direction == null ||
													!headsigns[Number(cell.key.direction)]?.trim()) &&
												!cell.evidence.counts.classified &&
												measuredShare(cell, 'on_time') === null
											),
									)
								: []}
						{#if cells.length}
							<FactList leading={false}>
								{#each cells as cell (cell.key.direction)}
									{@const share = measuredShare(cell, 'on_time')}
									{@const classified = cell.evidence.counts.classified}
									<FactRow
										label={directionLabel(cell.key.direction, headsigns, locale)}
										detail={share === null
											? undefined
											: t('on time', 'à l’heure') +
												(classified == null ? '' : ', ' + countedUnit(classified, 'event', locale))}
									>
										{#if share !== null}
											<strong>{recordPercent(share, locale)}</strong>
										{:else}
											<StateMark state={chartState(cell.state)} {locale} hiddenLabel />
											{rateStateText(cell, locale)}
										{/if}
									</FactRow>
								{/each}
							</FactList>
						{:else}
							{#await punctualityAnswer then headline}
								{#if result.kind === 'answer' || headline.kind === 'answer'}
									{@render gap(result, directionShape)}
								{/if}
							{/await}
						{/if}
					{/await}
				</div>
				{#snippet evidence()}
					{#await punctualityAnswer}
						<Skeleton class="h-5 w-48 max-w-full" />
					{:then result}
						{#if result.kind === 'answer'}<LineRecordEvidence
								evidence={result.answer.evidence}
								{locale}
							/>{/if}
					{/await}
				{/snippet}
			</RecordCard>

			<div id="daily" class="grid min-w-0">
				<RecordCard interactive title={title('daily')} {stamp} reserve="trend" stampRule>
					<div
						class="reading-body"
						style:--slot-wide={chartSlots.trend?.wide}
						style:--slot-phone={chartSlots.trend?.phone}
					>
						{#await dailyAnswer}
							{#key dailyAnswer}<RecordPending shape="trend" {locale} answer={dailyAnswer} />{/key}
						{:then result}
							{#if result.kind === 'answer' && 'cells' in result.answer && result.answer.cells.length}
								{@const answer = result.answer}
								{#snippet trend(network?: EngineResult<Answer> | null)}
									<RecordChart
										title={title('daily')}
										id="line-daily-chart"
										table={dailyTable}
										input={{
											kind: 'trend',
											answer,
											network:
												network?.kind === 'answer' &&
												'cells' in network.answer &&
												network.answer.evidence.start_date === answer.evidence.start_date &&
												network.answer.evidence.end_date === answer.evidence.end_date
													? network.answer
													: undefined,
										}}
										{locale}
									/>
								{/snippet}
								{#await networkDailyAnswer}{@render trend()}{:then network}{@render trend(
										network,
									)}{/await}
							{:else}{@render gap(result, 'trend')}{/if}
						{/await}
					</div>
					{#snippet evidence()}
						{#await dailyAnswer then result}
							{#if result.kind === 'answer'}
								<LineRecordEvidence evidence={result.answer.evidence} {locale} />
							{/if}
						{/await}
					{/snippet}
					{#snippet toggle()}
						{#await dailyAnswer}
							<Skeleton class="h-11 w-24" />
						{:then result}
							{#if result.kind === 'answer'}
								{#if 'cells' in result.answer && result.answer.cells.length}
									<RecordChartToggle bind:table={dailyTable} controls="line-daily-chart" {locale} />
								{/if}
							{/if}
						{/await}
					{/snippet}
				</RecordCard>
			</div>
		</DashboardGrid>
	</div>

	<div id="hourly" data-slot="line-hour-grid" class="min-w-0">
		<RecordCard interactive title={title('hourly')} {stamp} reserve="grid">
			{@render directionControl()}
			<div
				class="reading-body"
				style:--slot-wide={chartSlots.grid?.wide}
				style:--slot-phone={chartSlots.grid?.phone}
			>
				{#await hourlyAnswer}
					{#key hourlyAnswer}<RecordPending shape="grid" {locale} answer={hourlyAnswer} />{/key}
				{:then result}
					{#if result.kind === 'answer' && 'cells' in result.answer && result.answer.cells.length}
						<RecordChart
							title={title('hourly')}
							id="line-hour-chart"
							table={hoursTable}
							input={{ kind: 'hours', answer: result.answer }}
							{locale}
						/>
					{:else}{@render gap(result, 'grid')}{/if}
				{/await}
			</div>
			{#snippet evidence()}
				{#await hourlyAnswer then result}
					{#if result.kind === 'answer'}
						<LineRecordEvidence evidence={result.answer.evidence} {locale} />
					{/if}
				{/await}
			{/snippet}
			{#snippet toggle()}
				{#await hourlyAnswer}
					<Skeleton class="h-11 w-24" />
				{:then result}
					{#if result.kind === 'answer'}
						{#if 'cells' in result.answer && result.answer.cells.length}
							<RecordChartToggle bind:table={hoursTable} controls="line-hour-chart" {locale} />
						{/if}
					{/if}
				{/await}
			{/snippet}
		</RecordCard>
	</div>
{/if}

<style>
	.reading-body {
		min-block-size: var(--slot-wide);
	}
	@media (width < 40rem) {
		.reading-body {
			min-block-size: var(--slot-phone);
		}
	}
	@container (inline-size >= 32rem) {
		.paired-line-readings :global([data-slot='record-card'] > header) {
			align-items: flex-start;
			flex-wrap: nowrap;
		}
		.paired-line-readings :global([data-slot='record-card'] > header h2) {
			min-inline-size: 0;
		}
	}
</style>
