<script lang="ts">
	import type { Awaitable } from '#lib/site/ready.ts';
	import type { Locale } from '#lib/i18n/index.ts';
	import type { EngineResult, RankingAnswer } from '#lib/server/engine.ts';
	import type { ScheduleEdition } from '#lib/search/searchIndex.ts';
	import { countedUnit, missDirection, recordPercent } from '#lib/site/presenter.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { stopDisplayName } from '#lib/site/transitDisplay.ts';
	import { stopNameFallback } from '#lib/site/absence.ts';
	import RecordDataTable, { type RecordTableRow } from '../record/RecordDataTable.svelte';
	import RecordPending from '../record/RecordPending.svelte';
	import type { RecordSkeletonSpec } from '../record/recordWaiting.ts';
	import StateMark from '../record/StateMark.svelte';
	import { lastGoodNote } from '../record/recordText.ts';
	import { overviewCopy } from './overviewRecord.copy';
	import { previewRows, rankingState } from './overviewRecord.ts';

	let {
		locale,
		kind,
		ranking,
		link,
		directory,
		heading,
		outlineStopCode = false,
	}: {
		locale: Locale;
		kind: 'line' | 'stop';
		ranking: Awaitable<EngineResult<RankingAnswer>>;
		link: (path: string) => string;
		directory?: Awaitable<ScheduleEdition['stops']>;
		heading?: string;
		outlineStopCode?: boolean;
	} = $props();
	const display = transitDisplay();
	const title = $derived(
		kind === 'line' ? (locale === 'fr' ? 'Lignes' : 'Lines') : locale === 'fr' ? 'Arrêts' : 'Stops',
	);
	const rowHeader = $derived(
		kind === 'line' ? (locale === 'fr' ? 'Ligne' : 'Line') : locale === 'fr' ? 'Arrêt' : 'Stop',
	);
	type Row = RecordTableRow & { share: string };
	// The preview's three rows, a name over its counts, behind a line plate or a stop code.
	const waiting = $derived<RecordSkeletonSpec>({
		shape: 'rows',
		count: 3,
		lines: 2,
		lead: kind === 'line' ? 'plate' : 'code',
	});

	function rankRows(answer: RankingAnswer, stops: ScheduleEdition['stops']): Row[] {
		return previewRows(answer.rows).map((row) => {
			const line = kind === 'line' ? display.lineName(row.id) : null;
			const stop = kind === 'stop' ? stops.find((item) => item.id === row.id) : undefined;
			return {
				id: row.id,
				label:
					line?.name ??
					line?.label ??
					(stop ? stopDisplayName(stop.name) : stopNameFallback(row.id, locale)),
				leadingCode:
					kind === 'stop' ? { text: stop?.code || row.id, outline: outlineStopCode } : undefined,
				plate: line ? { code: line.number ?? row.id } : undefined,
				href: link((kind === 'line' ? '/lines/' : '/stop/') + encodeURIComponent(row.id)),
				// "778 stop events · early 72.0%, late 6.2%": which way the line or stop misses.
				detail: [countedUnit(row.sample, 'event', locale), missDirection(row.counts, locale)]
					.filter(Boolean)
					.join(' · '),
				share: recordPercent(row.value, locale),
			};
		});
	}
</script>

{#snippet share(row: Row)}<strong class="font-sans">{row.share}</strong>{/snippet}
{#snippet rows(answer: RankingAnswer, stops: ScheduleEdition['stops'] = [])}
	<RecordDataTable
		{locale}
		title={heading ?? title}
		{rowHeader}
		rows={rankRows(answer, stops)}
		columns={[
			{
				key: 'share',
				header: overviewCopy[locale].onTime.replaceAll(' ', '\u00a0'),
				numeric: true,
				cell: share,
			},
		]}
		value="share"
		rowAlign="middle"
		phone={{ line: (row) => row.detail }}
	/>
	{#if answer.coverage_note}<p>{answer.coverage_note[locale]}</p>{/if}
{/snippet}

<div class="min-w-0" data-slot="record-ranking">
	<h3 class="font-semibold">{heading ?? title}</h3>
	{#await ranking}
		{#key ranking}<RecordPending {locale} answer={ranking} shape={waiting} />{/key}
	{:then result}
		{#if result.kind === 'busy'}<RecordPending {locale} busy shape={waiting} />
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
