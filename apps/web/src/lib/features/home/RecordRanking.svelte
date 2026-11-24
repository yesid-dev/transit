<script lang="ts">
	import { RoutePlate } from '@yesid/ui/brand';
	import type { Locale } from '#lib/i18n/index.ts';
	import type { EngineResult, RankingAnswer } from '#lib/server/engine.ts';
	import type { ScheduleEdition } from '#lib/search/searchIndex.ts';
	import { countedUnit } from '#lib/site/presenter.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { stopDisplayName } from '#lib/site/transitDisplay.ts';
	import { stopNameFallback } from '#lib/site/absence.ts';
	import RecordPending from '../record/RecordPending.svelte';
	import StateMark from '../record/StateMark.svelte';
	import { lastGoodNote, coverageText } from '../record/recordText.ts';
	import { percent } from './overviewRecord.ts';

	let {
		locale,
		kind,
		ranking,
		link,
		directory,
	}: {
		locale: Locale;
		kind: 'line' | 'stop';
		ranking: Promise<EngineResult<RankingAnswer>>;
		link: (path: string) => string;
		directory?: Promise<ScheduleEdition['stops']>;
	} = $props();
	const display = transitDisplay();
	const title = $derived(
		kind === 'line' ? (locale === 'fr' ? 'Lignes' : 'Lines') : locale === 'fr' ? 'Arrêts' : 'Stops',
	);
</script>

{#snippet rows(answer: RankingAnswer, stops: ScheduleEdition['stops'] = [])}
	<ol>
		{#each answer.rows.slice(0, 3) as row (row.id)}
			{@const line = kind === 'line' ? display.lineName(row.id) : null}
			{@const stop = kind === 'stop' ? stops.find((item) => item.id === row.id) : undefined}
			{@const name =
				line?.name ??
				line?.label ??
				(stop ? stopDisplayName(stop.name) : stopNameFallback(row.id, locale))}
			{@const coverage = row.low_coverage ? coverageText(row, locale) : null}
			<li>
				<span class="plate">
					{#if line}<RoutePlate code={line.number ?? row.id} />
					{:else}<span class="font-mono text-sm">{stop?.code || row.id}</span>{/if}
				</span>
				<a
					class="inline-flex min-h-11 min-w-11 items-center font-semibold text-primary underline"
					href={link((kind === 'line' ? '/lines/' : '/stop/') + encodeURIComponent(row.id))}
					>{name}</a
				>
				<p class="text-muted-foreground">
					{countedUnit(row.sample, 'event', locale)}{coverage ? ` · ${coverage}` : ''}
				</p>
				<strong>{percent(row.value, locale)}</strong>
			</li>
		{/each}
	</ol>
	{#if answer.coverage_note}<p>{answer.coverage_note[locale]}</p>{/if}
{/snippet}

<div class="min-w-0" data-slot="record-ranking">
	<h3 class="font-semibold">{title}</h3>
	{#await ranking}
		{#key ranking}<RecordPending {locale} answer={ranking} />{/key}
	{:then result}
		{#if result.kind === 'busy'}<RecordPending {locale} busy />
		{:else if result.kind !== 'answer'}<StateMark state="not_measured" {locale} />
		{:else}
			{#if result.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
			{#if result.answer.rows.length}
				{#await directory}
					{@render rows(result.answer)}
				{:then names}
					{@render rows(result.answer, names)}
				{/await}
			{:else}
				{@const reason = result.answer.excluded[0]?.reason}
				{@const unanimous =
					reason && result.answer.excluded.every((item) => item.reason === reason)}
				{@const state = result.answer.state ?? (unanimous ? reason : 'not_measured')}
				<StateMark state={state === 'measured' ? 'not_measured' : state} {locale} />
			{/if}
		{/if}
	{/await}
</div>

<style>
	[data-slot='record-ranking'] {
		container-type: inline-size;
	}
	li {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: baseline;
		column-gap: var(--space-card-gap);
		border-block-start: 1px solid var(--border);
		padding-block-end: 0.5em;
		overflow-wrap: anywhere;
	}
	li p {
		grid-column: 2 / -1;
		grid-row: 2;
	}
	li strong {
		grid-column: 3;
		grid-row: 1;
	}
	@media (max-width: 25em) {
		li {
			column-gap: 0.5em;
		}
	}
	@container (max-width: 12rem) {
		li {
			grid-template-columns: minmax(0, 1fr) auto;
		}
		li a,
		li p {
			grid-column: 1 / -1;
		}
		li p {
			grid-row: 3;
		}
		li strong {
			grid-column: 2;
		}
	}
</style>
