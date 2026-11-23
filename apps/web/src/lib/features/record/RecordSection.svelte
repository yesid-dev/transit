<script lang="ts">
	import { Card } from '@yesid/ui/card';
	import type { Snippet } from 'svelte';
	import type { Locale } from '#lib/i18n/index.ts';
	import type { EngineResult, RecordAnswer } from '#lib/server/engine.ts';
	import RecordActions from './RecordActions.svelte';
	import RecordPending from './RecordPending.svelte';
	import { recordSectionLinks } from './recordLinks.ts';
	import { dateRange, lastGoodNote, methodEvidence, recordMessage } from './recordText.ts';

	let {
		section,
		title,
		subject,
		locale,
		url,
		answer,
		reading,
		statement,
		controls,
		printable = false,
	}: {
		section: string;
		title: string;
		subject: string;
		locale: Locale;
		url: URL;
		answer: Promise<EngineResult<RecordAnswer>>;
		reading: Snippet<[RecordAnswer]>;
		statement?: (answer: RecordAnswer) => string;
		controls?: Snippet;
		printable?: boolean;
	} = $props();

	const links = $derived(recordSectionLinks(url, section));
	function citation(result: RecordAnswer) {
		const evidence = result.evidence;
		return [
			`Transit · ${subject}. ${title}. ${dateRange({ from: evidence.start_date, to: evidence.end_date }, locale)}.`,
			statement?.(result),
			methodEvidence(evidence, locale),
			links.share,
		]
			.filter(Boolean)
			.join(' ');
	}
</script>

<Card edge="neutral" textSize="inherit" class="min-w-0 px-4 sm:px-6">
	<section id={section} aria-labelledby={`${section}-title`} class="grid min-w-0 gap-3">
		<h2 id={`${section}-title`}>{title}</h2>
		{@render controls?.()}
		{#await answer}
			{#key answer}<RecordPending {locale} />{/key}
		{:then result}
			{@const message = recordMessage(result, locale)}
			{#if result.kind === 'answer'}
				{#if result.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
				{@render reading(result.answer)}
				{#if result.answer.coverage_note}<p>{result.answer.coverage_note[locale]}</p>{/if}
				<div data-report-controls>
					<RecordActions
						{locale}
						{title}
						href={links.share}
						csv={links.csv}
						citation={citation(result.answer)}
					/>
				</div>
				{#if printable}<p class="report-citation">{citation(result.answer)}</p>{/if}
			{:else if message}
				<p>{message}</p>
			{/if}
		{/await}
	</section>
</Card>

<style>
	.report-citation {
		display: none;
	}
	@media print {
		.report-citation {
			display: block;
			overflow-wrap: anywhere;
			font-size: 9pt;
		}
	}
</style>
