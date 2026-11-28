<script lang="ts" generics="Answer extends Pick<RecordAnswer, 'evidence' | 'coverage_note'>">
	import type { Awaitable } from '#lib/site/ready.ts';
	import { Card } from '@yesid/ui/card';
	import { StateNotice } from '@yesid/ui/feedback';
	import type { Snippet } from 'svelte';
	import type { Locale } from '#lib/i18n/index.ts';
	import type { EngineResult, RecordAnswer } from '#lib/server/engine.ts';
	import RecordActions from './RecordActions.svelte';
	import RecordPending from './RecordPending.svelte';
	import type { RecordWaiting } from './recordWaiting.ts';
	import { recordSectionLinks } from './recordLinks.ts';
	import { lastGoodNote, recordConnection } from './recordText.ts';
	import { citeDates, methodEvidence } from '#lib/site/presenter.ts';

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
		waiting,
	}: {
		section: string;
		title: string;
		subject: string;
		locale: Locale;
		url: URL;
		answer: Awaitable<EngineResult<Answer>>;
		reading: Snippet<[Answer]>;
		statement?: (answer: Answer) => string;
		controls?: Snippet;
		printable?: boolean;
		/** The reading's final shape while it waits, and while the engine is busy. */
		waiting?: RecordWaiting;
	} = $props();

	const links = $derived(recordSectionLinks(url, section));
	function citation(result: Answer, lastGood?: true) {
		const evidence = result.evidence;
		return [
			`Transit · ${subject}. ${title}. ${citeDates({ from: evidence.start_date, to: evidence.end_date }, locale)}.`,
			statement?.(result),
			methodEvidence(evidence, locale),
			lastGood ? lastGoodNote[locale] : '',
			links.share,
		]
			.filter(Boolean)
			.join(' ');
	}
</script>

<Card interactive textSize="inherit" class="min-w-0 px-4 sm:px-6">
	<section id={section} aria-labelledby={`${section}-title`} class="grid min-w-0 gap-3">
		<h2 id={`${section}-title`}>{title}</h2>
		{@render controls?.()}
		{#await answer}
			{#key answer}<RecordPending {locale} {answer} shape={waiting} />{/key}
		{:then result}
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
						citation={citation(result.answer, result.lastGood)}
					/>
				</div>
				{#if printable}<p class="report-citation">
						{citation(result.answer, result.lastGood)}
					</p>{/if}
			{:else if result.kind === 'busy'}
				<RecordPending {locale} busy shape={waiting} />
			{:else}
				<StateNotice presentation="frameless" title={recordConnection[result.kind][locale]} />
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
