<script lang="ts">
	import { Separator } from '@yesid/ui/separator';
	import type { Snippet } from 'svelte';

	let {
		id,
		label,
		busy,
		detail,
		emphasis = false,
		children,
	}: {
		id?: string;
		label: string;
		busy?: boolean;
		detail?: string;
		emphasis?: boolean;
		children: Snippet;
	} = $props();
</script>

<div
	{id}
	class={['fact relative', detail && 'py-2']}
	class:has-detail={!!detail}
	data-slot="fact-row"
>
	<dt>
		<div class="fact-stroke">
			<Separator variant="hand-drawn" class="absolute inset-x-0 -top-[4px] print:hidden" />
		</div>
		{label}
	</dt>
	<dd class="tabular-nums" aria-busy={busy}>
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
	@container (width < 22rem) {
		.fact.has-detail {
			grid-template-columns: minmax(0, 1fr);
		}
		.fact.has-detail dd {
			text-align: start;
		}
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
