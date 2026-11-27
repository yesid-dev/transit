<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import { recordState, type RecordState } from './recordStates';

	let {
		state,
		locale,
		hiddenLabel = false,
	}: {
		state: RecordState;
		locale: Locale;
		hiddenLabel?: boolean;
	} = $props();
	const mark = $derived(recordState(state));
</script>

<span class="inline-flex min-w-0 items-baseline gap-2 font-semibold" data-record-state={state}>
	<span class="font-mono text-muted-foreground" aria-hidden="true">{mark.glyph}</span>
	{#if !hiddenLabel}<span class="font-sans">{mark[locale]}</span>{/if}
</span>
