<script lang="ts">
	import { StateNotice } from '@yesid/ui/feedback';
	import RecordLineLabel from '../record/RecordLineLabel.svelte';
	import type { Locale } from '#lib/i18n/index.ts';
	import type { EngineResult, RankingAnswer } from '#lib/server/engine.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import RecordPending from '../record/RecordPending.svelte';
	import {
		cautiousRanking,
		lastGoodNote,
		timingBasis,
		withCoverage,
	} from '../record/recordText.ts';
	import { percent, rankingText, tally } from './overviewRecord.ts';

	let {
		locale,
		kind,
		ranking,
	}: {
		locale: Locale;
		kind: 'line' | 'stop';
		ranking: Promise<EngineResult<RankingAnswer>>;
	} = $props();
	const display = transitDisplay();
	const title = $derived(
		kind === 'line' ? (locale === 'fr' ? 'Lignes' : 'Lines') : locale === 'fr' ? 'Arrêts' : 'Stops',
	);
</script>

<div class="min-w-0">
	<h3>{title}</h3>
	{#await ranking}
		{#key ranking}<RecordPending {locale} answer={ranking} />{/key}
	{:then result}
		{@const message = rankingText(result, locale)}
		{#if result.kind === 'answer' && result.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
		{#if result.kind === 'busy'}
			<RecordPending {locale} busy />
		{:else if message}
			<StateNotice presentation="frameless" title={message} />
		{:else if result.kind === 'answer'}
			{@const { rows, coverage_note, info } = result.answer}
			{#if rows.some((row) => row.ranking_bound != null)}<p>{cautiousRanking[locale]}</p>{/if}
			<ol class="grid gap-2 break-words">
				{#each rows as row (row.id)}
					{@const basis = timingBasis(row.counts, locale)}
					<li>
						<strong
							>{#if kind === 'line'}
								{@const line = display.lineName(row.id)}
								<RecordLineLabel label={line.label} code={line.number} />
							{:else}{row.id}{/if}</strong
						>
						· {withCoverage(percent(row.value, locale), row, locale)}
						<br />
						{#if locale === 'fr'}
							Intervalle estimé de {percent(row.range.lower, locale)} à {percent(
								row.range.upper,
								locale,
							)},
							{tally(row.sample, locale)} passages observés
						{:else}
							Estimated range {percent(row.range.lower, locale)} to {percent(
								row.range.upper,
								locale,
							)},
							{tally(row.sample, locale)} observed stop events
						{/if}
						{#if basis}<p>{basis}</p>{/if}
					</li>
				{/each}
			</ol>
			{#if info[0]}
				<p>
					{locale === 'fr'
						? `Le classement exclut les entrées qui comptent moins de ${tally(info[0].minimum_sample, locale)} passages observés.`
						: `The ranking excludes entries with fewer than ${tally(info[0].minimum_sample, locale)} observed stop events.`}
				</p>
			{/if}
			{#if coverage_note}<p>{coverage_note[locale]}</p>{/if}
		{/if}
	{/await}
</div>
