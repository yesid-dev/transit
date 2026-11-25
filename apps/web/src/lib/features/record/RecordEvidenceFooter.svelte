<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import type { RecordEvidence } from '#lib/server/engine.ts';
	import { methodEvidence } from '#lib/site/presenter.ts';

	let {
		evidence,
		versions,
		sample,
		locale,
	}: {
		sample?: string | null;
		locale: Locale;
	} & ({ evidence: RecordEvidence; versions?: never } | { evidence?: never; versions: string }) =
		$props();
	const method = $derived(evidence ? methodEvidence(evidence, locale, true) : versions);
</script>

<div
	class="flex w-full min-w-0 flex-wrap justify-between gap-x-4 gap-y-1 font-mono text-small text-muted-foreground"
>
	{#if sample}<span>{sample}</span>{/if}
	{#if method}<span>{method}</span>{/if}
</div>
