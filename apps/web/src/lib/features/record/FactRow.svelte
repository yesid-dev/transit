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
		children,
	}: {
		id?: string;
		label: string;
		busy?: boolean;
		detail?: string;
		/** A muted line under the label, so a long label keeps the row's width. */
		labelDetail?: string;
		emphasis?: boolean;
		children: Snippet;
	} = $props();
</script>

<div
	{id}
	class="fact relative"
	class:has-detail={!!detail}
	class:has-label-detail={!!labelDetail}
	data-slot="fact-row"
>
	<dt class="py-2 print:py-0">
		<div class="fact-stroke">
			<Separator variant="hand-drawn" class="absolute inset-x-0 -top-[4px] print:hidden" />
		</div>
		{label}
		{#if labelDetail}<span class="block text-small text-muted-foreground">{labelDetail}</span>{/if}
	</dt>
	<dd class={['tabular-nums', (detail || labelDetail) && 'py-2 print:py-0']} aria-busy={busy}>
		{#if emphasis}
			<strong class="font-heading text-heading font-extrabold">{@render children()}</strong>
		{:else}
			{@render children()}
		{/if}
		{#if detail}<span class="block text-small text-muted-foreground">{detail}</span>{/if}
	</dd>
</div>

<style>
	.fact {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		min-block-size: 2.75rem;
		align-items: center;
		gap: 0.25em 1em;
		overflow-wrap: break-word;
	}
	.fact:first-child .fact-stroke {
		display: var(--fact-leading, block);
	}
	.fact.has-detail {
		grid-template-columns: minmax(min-content, 1fr) minmax(0, max-content);
		align-items: start;
	}
	/* The label and its line take the free width; the value sits on the label's first line. */
	.fact.has-label-detail {
		align-items: start;
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
	@container (width < 16rem) {
		.fact,
		.fact.has-detail {
			grid-template-columns: minmax(0, 1fr);
		}
		dd {
			text-align: start;
		}
	}
</style>
