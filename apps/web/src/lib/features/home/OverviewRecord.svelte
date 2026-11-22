<script lang="ts">
	import { Card } from '@yesid/ui/card';
	import type { Locale } from '#lib/i18n/index.ts';
	import type { EngineResult, MeasureAnswer, RankingAnswer } from '#lib/server/engine.ts';
	import type { DateWindow } from '#lib/v1/history/window.ts';
	import CopyAction from '#lib/features/hotspots/sections/CopyAction.svelte';
	import HomeSearch from './HomeSearch.svelte';
	import RecordPending from '../record/RecordPending.svelte';
	import { lastGoodNote } from '../record/recordText.ts';
	import RecordRanking from './RecordRanking.svelte';
	import { citationText, comparisonText, dateRange, measureText } from './overviewRecord.ts';

	type Measure = Promise<EngineResult<MeasureAnswer>>;
	type Ranking = Promise<EngineResult<RankingAnswer>>;

	let {
		locale,
		city,
		href,
		record,
	}: {
		locale: Locale;
		city: string;
		href: string;
		record: {
			period: DateWindow;
			previous: DateWindow;
			punctuality: Measure;
			baseline: Measure;
			delivery: Measure;
			lines: Ranking;
			stops: Ranking;
		};
	} = $props();
	const fr = $derived(locale === 'fr');
	const id = $props.id();
</script>

{#snippet reading(promise: Measure, period: DateWindow)}
	{#await promise}
		{#key promise}<RecordPending {locale} />{/key}
	{:then result}
		{#if result.kind === 'answer' && result.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
		<p>{measureText(result, period, locale)}</p>
		{#if result.kind === 'answer' && result.answer.coverage_note}
			<p>{result.answer.coverage_note[locale]}</p>
		{/if}
	{/await}
{/snippet}

{#snippet citation(promise: Measure, period: DateWindow)}
	{#await promise then result}
		{#if result.kind === 'answer' && result.answer.state === 'measured'}
			<p>{citationText(result.answer, period, locale)}</p>
		{/if}
	{/await}
{/snippet}

<div class="grid gap-6">
	<h1>{fr ? 'Aperçu' : 'Overview'}{city ? ` · ${city}` : ''}</h1>

	<Card edge="neutral" textSize="inherit" class="px-4 sm:px-6">
		<section aria-labelledby={`${id}-punctuality`}>
			<h2 id={`${id}-punctuality`}>{fr ? 'Ponctualité' : 'On-time performance'}</h2>
			{@render reading(record.punctuality, record.period)}
		</section>

		<section aria-labelledby={`${id}-previous`}>
			<h2 id={`${id}-previous`}>{fr ? 'Période précédente' : 'Previous period'}</h2>
			{#await record.baseline}
				{#key record.baseline}<RecordPending {locale} />{/key}
			{:then baseline}
				{#if baseline.kind === 'answer' && baseline.answer.state !== 'measured'}
					<p>{dateRange(record.previous, locale)}</p>
				{/if}
				{#if baseline.kind === 'answer' && baseline.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
				<p>{measureText(baseline, record.previous, locale)}</p>
				{#if baseline.kind === 'answer' && baseline.answer.coverage_note}
					<p>{baseline.answer.coverage_note[locale]}</p>
				{/if}
				{#await record.punctuality then current}
					{@const change = comparisonText(current, baseline, locale)}
					{#if change}<p>{change}</p>{/if}
				{/await}
			{/await}
		</section>

		<section aria-labelledby={`${id}-delivery`}>
			<h2 id={`${id}-delivery`}>{fr ? 'Service effectué' : 'Service delivered'}</h2>
			{@render reading(record.delivery, record.period)}
		</section>
	</Card>

	<div class="max-w-md">
		<HomeSearch {locale} />
	</div>

	<Card edge="neutral" textSize="inherit" class="px-4 sm:px-6">
		<section aria-labelledby={`${id}-rankings`}>
			<h2 id={`${id}-rankings`}>
				{fr ? 'Lignes et arrêts à examiner' : 'Lines and stops to investigate'}
			</h2>
			<p>
				{fr
					? 'Les plus faibles taux de ponctualité pour la période choisie.'
					: 'The lowest on-time shares for the selected period.'}
			</p>
			<div class="grid gap-4 sm:grid-cols-2">
				<RecordRanking {locale} kind="line" ranking={record.lines} />
				<RecordRanking {locale} kind="stop" ranking={record.stops} />
			</div>
		</section>
	</Card>

	<div class="grid gap-3">
		{#key href}
			<CopyAction
				text={href}
				label={fr ? 'Copier le lien' : 'Copy link'}
				done={fr ? 'Lien copié.' : 'Link copied.'}
				fallback={fr ? 'Copiez le lien ci-dessous.' : 'Copy the link below.'}
				fallbackLabel={fr ? 'Lien vers cette vue' : 'Link to this view'}
			/>
		{/key}
		<details>
			<summary class="min-h-11 cursor-pointer py-3">{fr ? 'Citer' : 'Cite'}</summary>
			<p>Transit{city ? ` · ${city}` : ''}. {dateRange(record.period, locale)}.</p>
			{@render citation(record.punctuality, record.period)}
			{@render citation(record.baseline, record.previous)}
			{@render citation(record.delivery, record.period)}
		</details>
	</div>
</div>
