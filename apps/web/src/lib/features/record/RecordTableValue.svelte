<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import StateMark from './StateMark.svelte';
	import type { RecordState } from './recordStates.ts';

	let {
		locale,
		label,
		text,
		state = 'unknown',
	}: {
		locale: Locale;
		label: string;
		text: string | null;
		state?: RecordState;
	} = $props();
</script>

<span class="sr-only compact-label">{label}: </span>
{#if text === null}
	<StateMark {locale} {state} />
{:else}
	{text}
{/if}

<style>
	.compact-label {
		display: none;
	}
	@container yesid-table (max-width: 36rem) {
		.compact-label {
			display: inline;
		}
	}
</style>
