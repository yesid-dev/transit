<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import type { EngineResult, RankingAnswer } from '#lib/server/engine.ts';
	import type { ScheduleEdition } from '#lib/search/searchIndex.ts';
	import { countedUnit } from '#lib/site/presenter.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { stopDisplayName } from '#lib/site/transitDisplay.ts';
	import { stopNameFallback } from '#lib/site/absence.ts';
	import RecordDataTable, { type RecordTableRow } from '../record/RecordDataTable.svelte';
	import RecordPending from '../record/RecordPending.svelte';
	import StateMark from '../record/StateMark.svelte';
	import { lastGoodNote, coverageText } from '../record/recordText.ts';
	import { overviewCopy } from './overviewRecord.copy';
	import { percent, rankingState } from './overviewRecord.ts';

	let {
		locale,
		kind,
		ranking,
		link,
		directory,
		heading,
		formatShare,
		outlineStopCode = false,
	}: {
		locale: Locale;
		kind: 'line' | 'stop';
		ranking: Promise<EngineResult<RankingAnswer>>;
		link: (path: string) => string;
		directory?: Promise<ScheduleEdition['stops']>;
		heading?: string;
		formatShare?: (value: number) => string;
		outlineStopCode?: boolean;
	} = $props();
	const display = transitDisplay();
	const title = $derived(
		kind === 'line' ? (locale === 'fr' ? 'Lignes' : 'Lines') : locale === 'fr' ? 'Arrêts' : 'Stops',
	);
	type Row = RecordTableRow & { code: string; sample: string; share: string };

	function rankRows(answer: RankingAnswer, stops: ScheduleEdition['stops']): Row[] {
		return answer.rows.slice(0, 3).map((row) => {
			const line = kind === 'line' ? display.lineName(row.id) : null;
			const stop = kind === 'stop' ? stops.find((item) => item.id === row.id) : undefined;
			const coverage = row.low_coverage ? coverageText(row, locale) : null;
			return {
				id: row.id,
				label:
					line?.name ??
					line?.label ??
					(stop ? stopDisplayName(stop.name) : stopNameFallback(row.id, locale)),
				code: stop?.code || row.id,
				plate: line ? { code: line.number ?? row.id } : undefined,
				href: link((kind === 'line' ? '/lines/' : '/stop/') + encodeURIComponent(row.id)),
				sample: countedUnit(row.sample, 'event', locale) + (coverage ? ` · ${coverage}` : ''),
				share: formatShare?.(row.value) ?? percent(row.value, locale),
			};
		});
	}
</script>

{#snippet stopHeading(row: Row)}
	<div class="flex flex-wrap items-center gap-x-2">
		<span class="font-mono text-sm" class:stop-code={outlineStopCode}>{row.code}</span>
		<a class="inline-flex min-h-11 min-w-11 items-center text-primary underline" href={row.href}
			>{row.label}</a
		>
	</div>
{/snippet}
{#snippet sample(row: Row)}{row.sample}{/snippet}
{#snippet share(row: Row)}{row.share}{/snippet}
{#snippet rows(answer: RankingAnswer, stops: ScheduleEdition['stops'] = [])}
	<RecordDataTable
		{locale}
		title={heading ?? title}
		rowHeader={title}
		rows={rankRows(answer, stops)}
		columns={[
			{ key: 'share', header: overviewCopy[locale].onTime, numeric: true, cell: share },
			{ key: 'sample', header: overviewCopy[locale].counted, cell: sample },
		]}
		value="share"
		rowHeading={kind === 'stop' ? stopHeading : undefined}
	/>
	{#if answer.coverage_note}<p>{answer.coverage_note[locale]}</p>{/if}
{/snippet}

<div class="min-w-0" data-slot="record-ranking">
	<h3 class="font-semibold">{heading ?? title}</h3>
	{#await ranking}
		{#key ranking}<RecordPending {locale} answer={ranking} />{/key}
	{:then result}
		{#if result.kind === 'busy'}<RecordPending {locale} busy />
		{:else if result.kind !== 'answer'}<p>{overviewCopy[locale].unavailable}</p>
		{:else}
			{#if result.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
			{#if result.answer.rows.length}
				{#await directory}
					{@render rows(result.answer)}
				{:then names}
					{@render rows(result.answer, names)}
				{/await}
			{:else}
				{@const gap = rankingState(result.answer, locale)}
				<StateMark state={gap.state} {locale} />
				{#if gap.detail}<p class="text-muted-foreground">{gap.detail}</p>{/if}
			{/if}
		{/if}
	{/await}
</div>

<style>
	.stop-code {
		display: inline-block;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding-inline: 0.25em;
	}
</style>
