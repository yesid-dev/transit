<script lang="ts">
	import { Button } from '@yesid/ui/button';
	import { DashboardGrid } from '@yesid/ui/layout';
	import type { Locale } from '#lib/i18n/index.ts';
	import RecordActionGroup from '#lib/features/record/RecordActionGroup.svelte';
	import RecordAnswer from '#lib/features/record/RecordAnswer.svelte';
	import RecordCard from '#lib/features/record/RecordCard.svelte';
	import RecordChart from '#lib/features/record/charts/RecordChart.svelte';
	import RecordChartToggle from '#lib/features/record/charts/RecordChartToggle.svelte';
	import { chartState } from '#lib/features/record/charts/recordCharts.ts';
	import RecordPending from '#lib/features/record/RecordPending.svelte';
	import ScreenTitle from '#lib/features/record/ScreenTitle.svelte';
	import StateMark from '#lib/features/record/StateMark.svelte';
	import { recordSectionLinks } from '#lib/features/record/recordLinks.ts';
	import {
		choose,
		lastGoodNote,
		measuredShare,
		percent,
		rateStateText,
		recordMessage,
	} from '#lib/features/record/recordText.ts';
	import type { EngineResult, RecordAnswer as Answer, RecordMeasure } from '#lib/server/engine.ts';
	import type { loadLineRecord, LineSection } from '#lib/server/lineRecord.ts';
	import { countedUnit, directionLabel, recordStamp } from '#lib/site/presenter.ts';
	import { stopComparison } from '#lib/features/stops/stopRecordText.ts';
	import { lineCitation, lineSectionTitles, lineViewHref } from './lineRecordText.ts';
	import LineRecordEvidence from './LineRecordEvidence.svelte';

	let {
		name,
		code,
		subtitle,
		scheduleOnly,
		locale,
		record,
		pinned,
		back,
		headsigns,
	}: {
		name: string;
		code?: string | null;
		subtitle?: string;
		scheduleOnly?: boolean;
		locale: Locale;
		record: ReturnType<typeof loadLineRecord>;
		pinned: URL;
		back: string;
		headsigns: Record<number, string>;
	} = $props();

	const t = (en: string, fr: string) => choose(locale, en, fr);
	const title = (section: LineSection) => t(...lineSectionTitles[section]);
	const bands = $derived(t('Early, on time and late', 'En avance, à l’heure et en retard'));
	const stamp = $derived({ kind: 'record' as const, label: recordStamp(record.period, locale) });
	const answers = $derived(
		Object.fromEntries(record.sections.map(({ section, answer }) => [section, answer])) as Record<
			LineSection,
			Promise<EngineResult<Answer>>
		>,
	);
	const files = $derived(
		record.sections.map(({ section }) => ({
			href: recordSectionLinks(pinned, section).csv,
			label: title(section),
		})),
	);
	const options = $derived([
		null,
		...(['0', '1'] as const).filter((id) => headsigns[Number(id)] || record.direction === id),
	]);
	let dailyTable = $state(false);
	let hoursTable = $state(false);
</script>

{#snippet directionControl()}
	{#if options.length > 1}
		<nav
			class="flex min-w-0 flex-wrap gap-2"
			aria-label={t('Filter by direction', 'Filtrer par direction')}
		>
			{#each options as direction (direction)}
				{@const target = lineViewHref(pinned, 'record', direction)}
				{@const label =
					direction == null
						? t('Both directions', 'Les deux directions')
						: directionLabel(direction, headsigns, locale)}
				<Button
					href={target.pathname + target.search}
					variant={direction === record.direction ? 'default' : 'outline'}
					size="sm"
					class="min-h-11 min-w-11 max-w-full whitespace-normal"
					aria-current={direction === record.direction ? 'true' : undefined}>{label}</Button
				>
			{/each}
		</nav>
	{/if}
{/snippet}

{#snippet gap(result: EngineResult<Answer>)}
	{#if result.kind === 'busy'}
		<RecordPending {locale} busy />
	{:else if result.kind !== 'answer'}
		<p>
			{t('The record is temporarily unavailable.', 'Le bilan est temporairement indisponible.')}
		</p>
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
	{#each record.sections as { section, answer } (section)}
		{#await answer then result}
			{#if result.kind === 'answer'}
				<p>
					{lineCitation(
						name,
						title(section),
						result.answer,
						locale,
						recordSectionLinks(pinned, section).share,
					)}
				</p>
			{/if}
		{/await}
	{/each}
{/snippet}

{#snippet actions()}
	<RecordActionGroup {locale} href={pinned.href} {files} {citation} />
{/snippet}

{#snippet lead(answer: RecordMeasure, lastGood: boolean, comparison?: string)}
	{@const share = measuredShare(answer, 'on_time')}
	{#snippet meta()}
		<LineRecordEvidence evidence={answer.evidence} {locale} />
		{#if lastGood}<p>{lastGoodNote[locale]}</p>{/if}
	{/snippet}
	<RecordAnswer
		value={share === null ? null : percent(share, locale)}
		sentence={share === null
			? rateStateText(answer, locale)
			: t(
					'of observed stop events on this line were on time.',
					'des passages observés aux arrêts de cette ligne étaient à l’heure.',
				)}
		state={chartState(answer.state)}
		time={stamp}
		{locale}
		{meta}
		{actions}
		{comparison}
	/>
{/snippet}

<ScreenTitle
	title={name}
	plate={code ?? undefined}
	{subtitle}
	back={{ href: back, label: t('All lines', 'Toutes les lignes') }}
/>

<div id="punctuality" data-slot="screen-answer">
	{#if scheduleOnly}
		<RecordAnswer
			value={null}
			sentence={t('No live data for this line', 'Aucune donnée en direct pour cette ligne')}
			{locale}
			state="no_live_data"
		/>
	{:else}
		{#await answers.punctuality}
			{#key answers.punctuality}<RecordPending {locale} answer={answers.punctuality} />{/key}
		{:then result}
			{#if result.kind === 'answer' && 'value' in result.answer}
				{@const answer = result.answer}
				{#await record.network}
					{@render lead(answer, !!result.lastGood)}
				{:then network}
					{@render lead(
						answer,
						!!result.lastGood,
						network ? stopComparison(answer, network, locale) : undefined,
					)}
				{/await}
			{:else}
				{@render gap(result)}
			{/if}
		{/await}
	{/if}
</div>

{#if !scheduleOnly}
	<DashboardGrid gutter={false} minTile="20rem">
		<RecordCard title={bands} {stamp}>
			{#await answers.punctuality}
				{#key answers.punctuality}<RecordPending {locale} answer={answers.punctuality} />{/key}
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
							'En avance signifie plus de 1 minute avant l’heure prévue. En retard signifie plus de 5 minutes après l’heure prévue.',
						)}
					</p>
				{:else}{@render gap(result)}{/if}
			{/await}
			<div id="directions" class="mt-3 grid gap-2">
				<h3 class="font-semibold">{title('directions')}</h3>
				{#await answers.directions}
					{#key answers.directions}<RecordPending {locale} answer={answers.directions} />{/key}
				{:then result}
					{#if result.kind === 'answer' && 'cells' in result.answer && result.answer.cells.length}
						<dl class="grid gap-2">
							{#each result.answer.cells as cell (cell.key.direction)}
								{@const share = measuredShare(cell, 'on_time')}
								<div
									class="flex flex-wrap justify-between gap-x-2 border-b border-border pb-2 last:border-b-0"
								>
									<dt>{directionLabel(cell.key.direction, headsigns, locale)}</dt>
									<dd class="ml-auto text-right tabular-nums">
										{#if share !== null}
											<strong>{percent(share, locale)}</strong>
											<span class="block text-small text-muted-foreground">
												{t('on time', 'à l’heure')}{cell.evidence.counts.classified == null
													? ''
													: ', ' + countedUnit(cell.evidence.counts.classified, 'event', locale)}
											</span>
										{:else}
											<StateMark state={chartState(cell.state)} {locale} hiddenLabel />
											{rateStateText(cell, locale)}
										{/if}
									</dd>
								</div>
							{/each}
						</dl>
					{:else}{@render gap(result)}{/if}
				{/await}
			</div>
			{#snippet footer()}
				{#await answers.punctuality then result}
					{#if result.kind === 'answer'}<LineRecordEvidence
							evidence={result.answer.evidence}
							{locale}
						/>{/if}
				{/await}
			{/snippet}
		</RecordCard>

		<div id="daily" class="grid min-w-0">
			<RecordCard title={title('daily')} {stamp}>
				{#await answers.daily}
					{#key answers.daily}<RecordPending {locale} answer={answers.daily} />{/key}
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
						{#await record.networkDaily}{@render trend()}{:then network}{@render trend(
								network,
							)}{/await}
					{:else}{@render gap(result)}{/if}
				{/await}
				{#snippet footer()}
					{#await answers.daily then result}
						{#if result.kind === 'answer'}
							<LineRecordEvidence evidence={result.answer.evidence} {locale} />
							{#if 'cells' in result.answer && result.answer.cells.length}
								<RecordChartToggle bind:table={dailyTable} controls="line-daily-chart" {locale} />
							{/if}
						{/if}
					{/await}
				{/snippet}
			</RecordCard>
		</div>
	</DashboardGrid>

	<div id="hourly" data-slot="line-hour-grid" class="min-w-0">
		<RecordCard title={title('hourly')} {stamp}>
			{#await answers.hourly}
				{#key answers.hourly}<RecordPending {locale} answer={answers.hourly} />{/key}
			{:then result}
				{#if result.kind === 'answer' && 'cells' in result.answer && result.answer.cells.length}
					<RecordChart
						title={title('hourly')}
						id="line-hour-chart"
						table={hoursTable}
						input={{ kind: 'hours', answer: result.answer }}
						{locale}
					/>
				{:else}{@render gap(result)}{/if}
			{/await}
			{#snippet footer()}
				{#await answers.hourly then result}
					{#if result.kind === 'answer'}
						<LineRecordEvidence evidence={result.answer.evidence} {locale} />
						{#if 'cells' in result.answer && result.answer.cells.length}
							<RecordChartToggle bind:table={hoursTable} controls="line-hour-chart" {locale} />
						{/if}
					{/if}
				{/await}
				{@render directionControl()}
			{/snippet}
		</RecordCard>
	</div>
{/if}
