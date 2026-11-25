<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import StateMark from './StateMark.svelte';
	import type { RecordState } from './recordStates.ts';

	let {
		locale,

		text,
		state = 'unknown',
	}: {
		locale: Locale;

		text: string | null;
		state?: RecordState;
	} = $props();
</script>

{#if text === null}
	<StateMark {locale} {state} />
{:else}
	{text}
{/if}
