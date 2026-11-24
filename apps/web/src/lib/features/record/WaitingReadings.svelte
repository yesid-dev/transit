<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import type { RecordMeasure, RecordSeries } from '#lib/server/engine.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { choose, coverageText, periodCoverage, rateStateText } from './recordText.ts';
	import { methodEvidence } from '#lib/site/presenter.ts';
	import RecordTable from './RecordTable.svelte';
	import { waitingMeasures, waitingReading } from './waitingText.ts';

	let {
		data,
		title,
		locale,
	}: { data: RecordMeasure | RecordSeries; title: string; locale: Locale } = $props();
	const display = transitDisplay();
	const t = (en: string, fr: string) => choose(locale, en, fr);
	const lines = $derived(
		'cells' in data ? data.cells.filter((cell) => cell.state !== 'no_frequent_periods') : [],
	);
</script>

<p>
	{t(
		'Frequent periods have a scheduled interval of 10 minutes or less on average for the same line, stop and direction.',
		'En période fréquente, l’intervalle prévu est de 10 minutes ou moins en moyenne pour la même ligne, au même arrêt et dans la même direction.',
	)}
</p>
<p>{periodCoverage(data.evidence, locale)}. {methodEvidence(data.evidence, locale)}</p>

{#if 'cells' in data}
	{#if lines.length}
		<RecordTable
			{title}
			stack
			headers={[
				t('Line', 'Ligne'),
				...waitingMeasures.map(([, en, fr]) => t(en, fr)),
				t('Coverage', 'Couverture'),
			]}
			rows={lines.map((cell) => [
				display.lineName(String(cell.key.line)).label,
				...waitingMeasures.map(([id]) => waitingReading(cell, id, locale)),
				coverageText(cell.evidence, locale) || t('Unknown', 'Inconnue'),
			])}
		/>
	{:else if data.cells[0]}
		<p>{data.cells[0].state_text[locale]}</p>
	{/if}
{:else}
	{@const coverage = coverageText(data.evidence, locale)}
	{#if data.state === 'measured'}
		{#if coverage}<p>{coverage}.</p>{/if}
		<dl class="grid gap-4 sm:grid-cols-3">
			{#each waitingMeasures as [id, en, fr] (id)}
				<div>
					<dt>{t(en, fr)}</dt>
					<dd>{waitingReading(data, id, locale)}</dd>
				</div>
			{/each}
		</dl>
	{:else}
		<p>{rateStateText(data, locale)}</p>
		{#if coverage && !data.evidence.low_coverage && data.evidence.coverage_reason == null}<p>
				{coverage}.
			</p>{/if}
	{/if}
{/if}

<dl class="grid gap-2">
	{#each waitingMeasures as [id, en, fr] (id)}
		{@const definition = data.info?.find((method) => method.id === id)?.text?.[locale].definition}
		{#if definition}
			<div>
				<dt><strong>{t(en, fr)}</strong></dt>
				<dd>{definition}</dd>
			</div>
		{/if}
	{/each}
</dl>
