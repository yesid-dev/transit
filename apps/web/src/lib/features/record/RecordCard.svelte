<script lang="ts">
	import { Card } from '@yesid/ui/card';
	import { Stamp, type StampProps } from '@yesid/ui/brand';
	import type { Snippet } from 'svelte';

	let {
		title,
		stamp,
		footer,
		children,
	}: {
		title: string;
		stamp?: StampProps;
		footer?: Snippet;
		children: Snippet;
	} = $props();
	const id = $props.id();
</script>

<Card edge="neutral" textSize="inherit" class="min-w-0" spread>
	<article aria-labelledby={id} data-slot="record-card">
		<header class="flex min-w-0 flex-wrap items-center justify-between gap-2">
			<h2 {id}>{title}</h2>
			{#if stamp}<Stamp {...stamp} />{/if}
		</header>
		<div class="min-w-0">{@render children()}</div>
		{#if footer}<footer class="flex flex-wrap gap-x-4 gap-y-2">{@render footer()}</footer>{/if}
	</article>
</Card>

<style>
	article {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: var(--space-card-gap);
		min-inline-size: 0;
	}
	h2 {
		margin: 0;
		font-size: var(--text-heading);
	}
	footer {
		margin-block-start: auto;
	}
</style>
