<script lang="ts">
	import { Stamp, type StampProps } from '@yesid/ui/brand';
	import type { Snippet } from 'svelte';
	import RecordCard from '../record/RecordCard.svelte';

	let {
		id,
		title,
		stamp,
		presentation = 'log',
		children,
		evidence,
	}: {
		id: string;
		title: string;
		stamp?: StampProps;
		presentation?: 'excerpt' | 'log';
		children: Snippet;
		evidence?: Snippet;
	} = $props();
</script>

{#if presentation === 'excerpt'}
	<div {id}>
		<RecordCard {title} {stamp} interactive compactPrint stampRule {evidence}>
			{@render children()}
		</RecordCard>
	</div>
{:else}
	<section {id} class="grid min-w-0 gap-(--space-card-gap) scroll-mt-24">
		<header class="flex min-w-0 flex-wrap items-center justify-between gap-2">
			<h2 class="text-subheading font-semibold">{title}</h2>
			{#if stamp}<Stamp {...stamp} />{/if}
		</header>
		{@render children()}
		{@render evidence?.()}
	</section>
{/if}
