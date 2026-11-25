<script lang="ts">
	import { Separator } from '@yesid/ui/separator';
	import type { Snippet } from 'svelte';

	let { label, busy, children }: { label: string; busy?: boolean; children: Snippet } = $props();
</script>

<div class="fact relative py-2" data-slot="fact-row">
	<dt>
		<Separator variant="hand-drawn" class="absolute inset-x-0 -top-[4px] print:hidden" />
		{label}
	</dt>
	<dd class="tabular-nums" aria-busy={busy}>{@render children()}</dd>
</div>

<style>
	.fact {
		display: grid;
		grid-template-columns: fit-content(40%) minmax(0, 1fr);
		align-items: baseline;
		gap: 0.25em 1em;
		overflow-wrap: break-word;
	}
	dd {
		text-align: end;
	}
	@container (width < 16rem) {
		.fact {
			grid-template-columns: minmax(0, 1fr);
		}
		dd {
			text-align: start;
		}
	}
</style>
