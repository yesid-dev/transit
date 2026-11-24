<script lang="ts">
	import { AnswerLead, Stamp } from '@yesid/ui/brand';
	import type { StampProps } from '@yesid/ui/brand';
	import type { Snippet } from 'svelte';
	import type { Locale } from '#lib/i18n/index.ts';
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
	}: {
		value: string | null;
		sentence: string;
		state?: RecordState;
		locale: Locale;
		time?: StampProps;
		comparison?: string;
		actions?: Snippet;
		meta?: Snippet;
	} = $props();
</script>

{#snippet absent()}{#if state}<StateMark {state} {locale} hiddenLabel />{/if}{/snippet}
{#snippet stamp()}{#if time}<Stamp {...time} />{/if}{/snippet}
<AnswerLead
	{value}
	{sentence}
	{absent}
	stamp={time ? stamp : undefined}
	{comparison}
	{actions}
	{meta}
	size="md"
/>
