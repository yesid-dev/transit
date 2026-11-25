<script lang="ts">
	import { AnswerLead, Stamp } from '@yesid/ui/brand';
	import type { StampProps } from '@yesid/ui/brand';
	import type { Snippet } from 'svelte';
	import type { Locale } from '#lib/i18n/index.ts';
	import type { RecordEvidence } from '#lib/server/engine.ts';
	import { methodEvidence } from '#lib/site/presenter.ts';
	import { choose, lastGoodNote } from './recordText.ts';
	import StateMark from './StateMark.svelte';
	import type { RecordState } from './recordStates';

	let {
		value,
		sentence,
		state,
		locale,
		time,
		comparison,
		actions,
		meta,
		evidence,
	}: {
		value: string | null;
		sentence: string;
		state?: RecordState;
		locale: Locale;
		time?: StampProps;
		comparison?: string;
		actions?: Snippet;
		meta?: Snippet;
		evidence?: { sample: string; record: RecordEvidence; lastGood?: boolean };
	} = $props();
</script>

{#snippet absent()}{#if state}<StateMark {state} {locale} hiddenLabel />{/if}{/snippet}
{#snippet stamp()}{#if time}<Stamp {...time} />{/if}{/snippet}
{#snippet evidenceMeta()}
	{#if evidence}
		{#if evidence.sample}<p>
				{`${choose(locale, 'Counted:', 'Ce qui est compté :')} ${evidence.sample}`}
			</p>{/if}
		<p class="font-mono text-small text-muted-foreground">
			{methodEvidence(evidence.record, locale, true)}
		</p>
		{#if evidence.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
	{/if}
	{@render meta?.()}
{/snippet}
<AnswerLead
	{value}
	{sentence}
	absent={state ? absent : undefined}
	stamp={time ? stamp : undefined}
	{comparison}
	{actions}
	meta={evidence || meta ? evidenceMeta : undefined}
	size="lg"
/>
