<script lang="ts">
	import { Separator } from '@yesid/ui/separator';
	import type { Snippet } from 'svelte';

	let {
		id,
		label,
		busy,
		children,
	}: { id?: string; label: string; busy?: boolean; children: Snippet } = $props();
</script>

<div {id} class="fact relative py-2" data-slot="fact-row">
	<dt>
		<div class="fact-stroke">
			<Separator variant="hand-drawn" class="absolute inset-x-0 -top-[4px] print:hidden" />
		</div>
		{label}
	</dt>
	<dd class="tabular-nums" aria-busy={busy}>{@render children()}</dd>
</div>

<style>
	.fact {
		display: grid;
		grid-template-columns: fit-content(40%) minmax(0, 1fr);
		min-block-size: 2.75rem;
		align-items: center;
		gap: 0.25em 1em;
		overflow-wrap: break-word;
	}
	.fact:first-child .fact-stroke {
		display: var(--fact-leading, block);
	}
	dt {
		min-inline-size: min-content;
		overflow-wrap: normal;
		word-break: normal;
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
