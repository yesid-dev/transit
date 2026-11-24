<script lang="ts">
	import { getLocalizeHref, type Locale } from '#lib/i18n/index.ts';
	import { routeFor } from '#lib/nav/index.ts';
	import { lastGoodNote } from '../record/recordText';
	import RecordPending from '../record/RecordPending.svelte';
	import { measureText, type OverviewPunctuality } from './overviewRecord';
	import type { HomePulseCopy } from './homePulse.copy';

	let {
		locale,
		record,
		copy: t,
	}: {
		locale: Locale;
		record: OverviewPunctuality | null;
		copy: HomePulseCopy;
	} = $props();
	const localizeHref = getLocalizeHref();
</script>

<section class="home-record" data-slot="home-record" aria-labelledby="home-record-title">
	<h2 id="home-record-title">{t.recordTitle}</h2>
	{#if record}
		{@const period = record.period}
		{#await record.punctuality}
			{#key record.punctuality}<RecordPending {locale} answer={record.punctuality} />{/key}
		{:then result}
			{#if result.kind === 'answer' && result.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
			<p>{measureText(result, period, locale)}</p>
			{#if result.kind === 'answer' && result.answer.coverage_note}
				<p>{result.answer.coverage_note[locale]}</p>
			{/if}
		{/await}
	{:else}
		<p>{t.recordNone}</p>
	{/if}
	<p class="home-card-actions">
		<a class="home-card-action" href={localizeHref(routeFor({ kind: 'network-health' }), locale)}
			>{t.openRecord}</a
		>
	</p>
</section>
