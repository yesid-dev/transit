<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import type { RecordEvidence } from '#lib/server/engine.ts';
	import { methodEvidence } from '#lib/site/presenter.ts';

	let {
		evidence,
		sample,
		locale,
	}: {
		evidence: RecordEvidence;
		sample?: string | null;
		locale: Locale;
	} = $props();
</script>

<div
	class="flex w-full min-w-0 flex-wrap justify-between gap-x-4 gap-y-1 border-t border-border pt-2 font-mono text-small text-muted-foreground"
>
	{#if sample}<span>{sample}</span>{/if}
	<span class="ml-auto">{methodEvidence(evidence, locale, true)}</span>
</div>
