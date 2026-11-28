<script lang="ts">
	import { Button } from '@yesid/ui/button';
	import * as Collapsible from '@yesid/ui/collapsible';
	import type { DataTableColumn } from '@yesid/ui/table';
	import RecordDataTable, {
		type RecordTableRow,
	} from '#lib/features/record/RecordDataTable.svelte';
	import StateMark from '#lib/features/record/StateMark.svelte';
	import RecordTableName from '#lib/features/record/RecordTableName.svelte';
	import { chartState, minimumSample } from '#lib/features/record/charts/recordCharts.ts';
	import { choose, coverageText, measuredShare, tally } from '#lib/features/record/recordText.ts';
	import { localizeHref, type Locale } from '#lib/i18n/index.ts';
	import type { RecordSeries } from '#lib/server/engine.ts';
	import { recordPercent, countedUnit } from '#lib/site/presenter.ts';
	import { waitingMeasures, waitingReadingParts } from '#lib/features/record/waitingText.ts';
	import { carryFrameState } from '#lib/site/frameState.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { stopCoverageGap } from './stopRecordText.ts';

	let {
		series,
		locale,
		city,
		pinned,
		title,
		waiting = false,
	}: {
		series: RecordSeries;
		locale: Locale;
		city: string;
		pinned: URL;
		title: string;
		waiting?: boolean;
	} = $props();
	const display = transitDisplay();
	const t = (en: string, fr: string) => choose(locale, en, fr);
	const waitingCoverageMinimum = $derived(
		series.info?.find(({ id }) => id === waitingMeasures[0][0])?.minimum_coverage,
	);
	type Row = RecordTableRow & {
		name: ReturnType<typeof display.lineName>;
		state: ReturnType<typeof chartState>;
		share: number | null;
		sample: number | null;
		cell: RecordSeries['cells'][number];
		coverageGap: string | null;
	};
	const rows = $derived(
		series.cells.flatMap((cell): Row[] => {
			const id = cell.key.line;
			if (typeof id !== 'string' || cell.state === 'no_frequent_periods') return [];
			// A line with no stop event here says nothing about this stop: no row.
			if (!waiting && !cell.evidence.counts.classified && cell.state !== 'measured') return [];
			const name = display.lineName(id);
			return [
				{
					id,
					name,
					label: name.name ?? '',
					plate: { code: name.number ?? id },
					href: carryFrameState(
						localizeHref('/lines/' + encodeURIComponent(id), locale, city),
						pinned,
					),
					state: chartState(cell.state),
					share: measuredShare(cell, 'on_time'),
					sample: cell.evidence.counts.classified ?? null,
					cell,
					coverageGap: waiting ? stopCoverageGap(cell, locale, true, waitingCoverageMinimum) : null,
				},
			];
		}),
	);
	const columns = $derived<DataTableColumn<Row>[]>([
		...(waiting
			? [
					{
						key: 'excess_wait_time',
						header: t(waitingMeasures[0][1], waitingMeasures[0][2]),
						cell: excess,
					},
					{
						key: 'long_gaps',
						header: t(waitingMeasures[1][1], waitingMeasures[1][2]),
						numeric: true,
						cell: gaps,
					},
					{
						key: 'bunching',
						header: t(waitingMeasures[2][1], waitingMeasures[2][2]),
						numeric: true,
						cell: bunching,
					},
				]
			: [
					{
						key: 'value',
						header: t('On-time share', 'Part à l’heure'),
						numeric: true,
						cell: value,
					},
					{
						key: 'count',
						header: t('Stop arrivals here', 'Passages à cet arrêt'),
						numeric: true,
						cell: count,
					},
				]),
	]);
</script>

{#snippet value(row: Row)}
	{#if row.share === null}<StateMark state={row.state} {locale} />
	{:else}{recordPercent(row.share, locale)}{/if}
{/snippet}
{#snippet count(row: Row)}
	{@const minimum = minimumSample(series, 'on_time')}
	{#if row.state === 'too_few_to_judge' && row.sample !== null && minimum != null}
		<!-- A sentence, not a reading: it may wrap. -->
		<span class="font-sans text-small whitespace-normal text-muted-foreground"
			>{t(
				`${countedUnit(row.sample, 'event', locale)}, the minimum is ${tally(minimum, locale)}`,
				`${countedUnit(row.sample, 'event', locale)}, le minimum est de ${tally(minimum, locale)}`,
			)}</span
		>
	{:else if row.sample !== null}{tally(row.sample, locale)}
	{:else}<span class="sr-only">{t('Unknown', 'Inconnu')}</span>{/if}
{/snippet}

{#snippet waitingValue(row: Row, id: (typeof waitingMeasures)[number][0])}
	<div class="waiting-cell" class:waiting-explanation={id === waitingMeasures[0][0]}>
		{#if row.coverageGap}
			{#if id === waitingMeasures[0][0]}<span class="font-sans">{row.coverageGap}</span>{/if}
		{:else}
			{@const reading = waitingReadingParts(row.cell, id, locale)}
			{@const detail =
				reading.detail ??
				(id === 'excess_wait_time' ? coverageText(row.cell.evidence, locale) : '')}
			<span class:waiting-number={!!(reading.measured || reading.detail)}>{reading.value}</span>
			{#if detail}
				<span
					class="block font-sans text-small text-muted-foreground"
					class:waiting-count={id !== 'excess_wait_time'}>{detail}</span
				>
			{/if}
		{/if}
	</div>
{/snippet}
{#snippet excess(row: Row)}{@render waitingValue(row, 'excess_wait_time')}{/snippet}
{#snippet gaps(row: Row)}{@render waitingValue(row, 'long_gaps')}{/snippet}
{#snippet bunching(row: Row)}{@render waitingValue(row, 'bunching')}{/snippet}

{#if rows.length}
	<RecordDataTable
		{locale}
		{title}
		rowHeader={t('Line', 'Ligne')}
		value={waiting ? undefined : 'value'}
		{columns}
		{rows}
		pageSize={rows.length > 12 ? 12 : undefined}
	>
		{#snippet rowHeading(row)}<RecordTableName
				{row}
				plates
				columnCount={columns.length + 1}
				inlinePlate
			/>{/snippet}
	</RecordDataTable>
{:else if series.cells[0]}<p>{series.cells[0].state_text[locale]}</p>{/if}

{#if waiting}
	<Collapsible.Root class="mt-3">
		<Collapsible.Trigger>
			{#snippet child({ props })}
				<Button {...props} size="sm" variant="outline" class="min-h-11"
					>{t('Definitions', 'Définitions')}</Button
				>
			{/snippet}
		</Collapsible.Trigger>
		<Collapsible.Content class="pt-3">
			<div class="grid gap-2 text-small">
				{#each waitingMeasures as [id, en, fr] (id)}
					{@const definition = series.info?.find((item) => item.id === id)?.text?.[locale]
						.definition}
					{#if definition}<p><strong>{t(en, fr)}</strong> {definition}</p>{/if}
				{/each}
			</div>
		</Collapsible.Content>
	</Collapsible.Root>
{/if}

<style>
	/* On a phone the kit joins a row's cells with a middle dot: an inline cell keeps the dot beside
	   its reading instead of alone on a line above it. */
	@container (inline-size < 38rem) {
		.waiting-cell {
			display: inline;
		}
	}
	@container (inline-size >= 38rem) {
		.waiting-explanation {
			min-inline-size: min(16rem, 30cqi);
		}
		.waiting-number,
		.waiting-count {
			white-space: nowrap;
		}
		.waiting-count {
			display: inline;
		}
		.waiting-count::before {
			content: ' · ';
		}
	}
</style>
