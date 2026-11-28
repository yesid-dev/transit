<script lang="ts">
	import { Separator } from '@yesid/ui/separator';
	import type { Snippet } from 'svelte';

	let {
		id,
		label,
		busy,
		detail,
		labelDetail,
		emphasis = false,
		note,
		children,
	}: {
		id?: string;
		label: string;
		busy?: boolean;
		detail?: string;
		/** A muted line under the label, so a long label keeps the row's width. */
		labelDetail?: string;
		emphasis?: boolean;
		/** Explanation that needs the width of the whole row. */
		note?: Snippet;
		children: Snippet;
	} = $props();
</script>

<div {id} class="fact relative" data-slot="fact-row">
	<dt class="py-2 print:py-0">
		<div class="fact-stroke">
			<Separator decorative class="absolute inset-x-0 top-0 print:hidden" />
		</div>
		{label}
		{#if labelDetail}<span class="block text-small text-muted-foreground">{labelDetail}</span>{/if}
	</dt>
	<dd class="py-2 font-mono tabular-nums print:py-0" aria-busy={busy}>
		{#if emphasis}
			<strong class="font-heading text-heading font-extrabold">{@render children()}</strong>
		{:else}
			{@render children()}
		{/if}
		{#if detail}<span class="block font-sans text-small text-muted-foreground">{detail}</span>{/if}
	</dd>
	{#if note}<dd class="note col-span-full pb-2 font-sans text-muted-foreground print:pb-0">
			{@render note()}
		</dd>{/if}
</div>

<style>
	/* The label takes the free width; long values wrap before squeezing it. */
	.fact {
		display: grid;
		grid-template-columns: var(
			--fact-row-columns,
			minmax(min(9rem, 45%), 1fr) minmax(0, max-content)
		);
		min-block-size: 2.75rem;
		align-items: baseline;
		gap: 0.25em 1em;
		overflow-wrap: break-word;
	}
	.fact:first-child .fact-stroke {
		display: var(--fact-leading, block);
	}
	dt {
		min-inline-size: 0;
		overflow-wrap: normal;
		word-break: normal;
	}
	dd {
		min-inline-size: 0;
		text-align: end;
	}
	.note {
		text-align: start;
	}
	.note,
	dd :global(p) {
		font-family: var(--font-body);
	}
	@container fact-list (inline-size < 24rem) {
		dd :global(p) {
			text-align: start;
		}
	}
	@container fact-list (inline-size < 16rem) {
		.fact {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
