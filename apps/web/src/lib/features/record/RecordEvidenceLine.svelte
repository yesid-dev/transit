<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import type { RecordEvidence } from '#lib/server/engine.ts';
	import { methodEvidence } from '#lib/site/presenter.ts';

	let {
		evidence,
		versions,
		sample,
		note,
		locale,
	}: {
		sample?: string | null;
		note?: string | null;
		locale: Locale;
	} & ({ evidence: RecordEvidence; versions?: never } | { evidence?: never; versions: string }) =
		$props();
	// Versions stay machine-readable for downloads and citations; riders read only the sample.
	const method = $derived(evidence ? methodEvidence(evidence, locale, true) : versions);
</script>

{#if sample || note}
	<div
		class="flex min-w-0 flex-wrap justify-between gap-x-4 gap-y-1 font-mono text-small text-muted-foreground"
		data-method={method || undefined}
	>
		{#if sample}<span>{sample}</span>{/if}
		{#if note}<span>{note}</span>{/if}
	</div>
{/if}
