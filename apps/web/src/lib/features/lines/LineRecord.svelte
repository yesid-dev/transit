<script lang="ts">
	import RecordGroup from '#lib/features/record/RecordGroup.svelte';
	import { Button } from '@yesid/ui/button';

	import { localizeHref, type Locale } from '#lib/i18n/index.ts';
	import AboutFigures from '#lib/features/record/AboutFigures.svelte';
	import RecordCard from '#lib/features/record/RecordCard.svelte';
	import RecordPending from '#lib/features/record/RecordPending.svelte';

	import StateMark from '#lib/features/record/StateMark.svelte';
	import { chartState } from '#lib/features/record/charts/recordCharts.ts';
	import RecordChartToggle from '#lib/features/record/charts/RecordChartToggle.svelte';
	import {
		choose,
		lastGoodNote,
		punctualityWeighting,
		pooledDays,
		recordMessage,
		tally,
		timingBasis,
	} from '#lib/features/record/recordText.ts';
	import { recordPercent, dateRange, recordStamp } from '#lib/site/presenter.ts';
	import type { loadLineRecord, LineSection } from '#lib/server/lineRecord.ts';
	import type { EngineResult, RecordAnswer, RecordMeasure } from '#lib/server/engine.ts';
	import { carryFrameState, frameHref } from '#lib/site/frameState.ts';
	import { overviewCopy } from '../home/overviewRecord.copy.ts';
	import LineRecordReadings from './LineRecordReadings.svelte';
	import LineRecordTop from './LineRecordTop.svelte';
	import LineScheduleCard from './LineScheduleCard.svelte';
	import LineMeasurementLimits from './LineMeasurementLimits.svelte';
	import LineRecordEvidence from './LineRecordEvidence.svelte';
	import LineStopLadder from './LineStopLadder.svelte';
	import { lineSectionTitles, lineTimetableOnly, lineViewHref } from './lineRecordText.ts';

	let {
		name,

		scheduleOnly,
		locale,
		url,
		record,
		headsigns,
		stopNames,
		stopCodes,
		operator,
	}: {
		name: string;

		scheduleOnly?: boolean;
		locale: Locale;
		url: URL;
		record: ReturnType<typeof loadLineRecord>;
		headsigns: Record<number, string>;
		stopNames: Record<string, string>;
		stopCodes: Record<string, string>;
		operator: string;
	} = $props();

	const t = (en: string, fr: string) => choose(locale, en, fr);
	const title = (section: LineSection) => t(...lineSectionTitles[section]);
	const term = $derived(overviewCopy[locale]);
	const pinned = $derived.by(() => {
		const link = lineViewHref(url, 'record', record.direction);
		link.searchParams.set('provider', record.city);
		return new URL(
			frameHref(link, { mode: 'record', period: { ...record.period, preset: null } }),
			url,
		);
	});
	const link = (path: string) => carryFrameState(localizeHref(path, locale, record.city), pinned);
	const corridorMap = $derived.by(() => {
		const target = new URL(localizeHref('/map', locale, record.city), pinned);
		target.searchParams.set('mapLayer', 'corridors');
		target.searchParams.set('recordLine', record.line);
		if (record.direction != null) target.searchParams.set('recordDirection', record.direction);
		return frameHref(target, { mode: 'record', period: { ...record.period, preset: null } });
	});
	const stamp = $derived({ kind: 'record' as const, label: recordStamp(record.period, locale) });
	const answerFor = (section: LineSection) =>
		record.sections.find((item) => item.section === section)!.answer;
	const stopsAnswer = $derived(answerFor('stops'));

	const punctualityAnswer = $derived(answerFor('punctuality'));
	const failures = ['stops', 'delivery', 'late', 'waiting', 'offered', 'crowding'] as const;
	let opened = $state<Record<(typeof failures)[number], boolean>>({
		stops: true,
		delivery: true,
		late: true,
		waiting: true,
		offered: true,
		crowding: true,
	});
	const anyOpen = $derived(failures.some((section) => opened[section]));
	let stopsTable = $state(false);

	function toggleAll() {
		const open = !anyOpen;
		for (const section of failures) opened[section] = open;
	}
</script>

{#snippet pending(answer: Promise<EngineResult<RecordAnswer>>)}
	{#key answer}<RecordPending {locale} {answer} />{/key}
{/snippet}

{#snippet gap(result: EngineResult<RecordAnswer>)}
	{#if result.kind === 'busy'}
		<RecordPending {locale} busy />
	{:else if result.kind !== 'answer'}
		<p>
			{t('The record is temporarily unavailable.', 'Le bilan est temporairement indisponible.')}
		</p>
	{:else}
		<p>
			<StateMark
				state={chartState('state' in result.answer ? result.answer.state : undefined)}
				{locale}
				hiddenLabel
			/>
			{recordMessage(result, locale)}
		</p>
	{/if}
{/snippet}

{#snippet reading(section: LineSection)}
	{@const answer = answerFor(section)}
	{#await answer}
		{@render pending(answer)}
	{:then result}
		{#if result.kind === 'answer' && !recordMessage(result, locale)}
			{#if section === 'stops' && 'cells' in result.answer}
				<LineStopLadder
					series={result.answer}
					title={title(section)}
					{locale}
					{headsigns}
					{stopNames}
					{stopCodes}
					{pinned}
					city={record.city}
					table={stopsTable}
				/>
			{:else}
				<LineRecordReadings
					answer={result.answer}
					{section}
					{locale}
					title={title(section)}
					{headsigns}
					url={pinned}
					line={record.line}
					city={record.city}
					{stopNames}
					{operator}
				/>
			{/if}
			{#if result.lastGood}<p class="mt-3 text-small text-muted-foreground">
					{lastGoodNote[locale]}
				</p>{/if}
		{:else}{@render gap(result)}{/if}
	{/await}
{/snippet}

{#snippet sectionEvidence(section: LineSection)}
	{@const answer = answerFor(section)}
	{#await answer then result}
		{#if result.kind === 'answer'}<LineRecordEvidence
				evidence={result.answer.evidence}
				{locale}
			/>{/if}
	{/await}
{/snippet}

{#snippet failureGroup()}
	<RecordGroup aria-labelledby="line-failures-heading">
		<div class="flex flex-wrap items-center justify-between gap-2">
			<h2 id="line-failures-heading" class="text-heading font-bold">
				{t('Where and when it fails', 'Où et quand le service fait défaut')}
			</h2>
			<Button variant="outline" size="sm" class="min-h-11" onclick={toggleAll}
				>{anyOpen ? t('Collapse all', 'Tout replier') : t('Expand all', 'Tout déplier')}</Button
			>
		</div>
		{#each failures as section (section)}
			<div id={section} class="min-w-0">
				<RecordCard
					title={title(section)}
					{stamp}
					interactive
					expandable
					bind:open={opened[section]}
				>
					{@render reading(section)}
					{#snippet evidence()}
						{@render sectionEvidence(section)}
					{/snippet}
					{#snippet toggle()}
						{#if section === 'stops'}
							{#await stopsAnswer then result}
								{#if result.kind === 'answer' && 'cells' in result.answer && result.answer.cells.length}
									<RecordChartToggle bind:table={stopsTable} controls="line-stop-ladder" {locale} />
								{/if}
							{/await}
						{/if}
					{/snippet}
				</RecordCard>
			</div>
		{/each}
	</RecordGroup>
{/snippet}

{#snippet about(answer: RecordMeasure | null)}
	<AboutFigures
		title={term.about}
		fields={[
			{ key: 'period', label: term.period, text: dateRange(record.period, locale) },
			{
				key: 'counted',
				label: term.counted,
				text: answer
					? [
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
										recordPercent(answer.evidence.share_observed, locale),
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
				key: 'method',
				label: term.methodRow,
				text: null,
				link: { href: link('/metrics'), label: term.method },
			},
			{ key: 'source', label: term.source, text: term.feeds(operator) },
		]}
	/>
	<a class="inline-flex min-h-11 w-fit items-center text-primary underline" href={corridorMap}
		>{t('See corridors on the map', 'Voir les corridors sur la carte')}</a
	>
{/snippet}

<div data-slot="screen-content" class="min-w-0">
	<RecordGroup>
		<LineRecordTop {name} {scheduleOnly} {locale} {record} {pinned} {headsigns} {operator} />
		{#if scheduleOnly}
			<LineScheduleCard {record} {locale} {url} {headsigns} />
		{/if}
	</RecordGroup>
	{#if scheduleOnly}
		<RecordGroup><LineMeasurementLimits {locale} methodHref={link('/metrics')} /></RecordGroup>
	{:else}
		{#await punctualityAnswer then result}
			{@const answer = result.kind === 'answer' && 'value' in result.answer ? result.answer : null}
			{#if !lineTimetableOnly(answer)}
				{@render failureGroup()}
			{/if}
		{/await}
		<RecordGroup>
			<LineScheduleCard {record} {locale} {url} {headsigns} />
			{#await punctualityAnswer then result}
				{@const answer =
					result.kind === 'answer' && 'value' in result.answer ? result.answer : null}
				{#if !lineTimetableOnly(answer)}
					<div id="alerts">
						<RecordCard interactive title={title('alerts')} {stamp}>
							{@render reading('alerts')}
							{#snippet evidence()}
								{@render sectionEvidence('alerts')}
							{/snippet}
						</RecordCard>
					</div>
				{/if}
			{/await}
		</RecordGroup>
		{#await punctualityAnswer then result}
			{@const answer = result.kind === 'answer' && 'value' in result.answer ? result.answer : null}
			{#if !lineTimetableOnly(answer)}
				<RecordGroup>{@render about(answer)}</RecordGroup>
			{/if}
		{/await}
	{/if}
</div>
