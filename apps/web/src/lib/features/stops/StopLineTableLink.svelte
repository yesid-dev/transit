<script lang="ts">
	import { RoutePlate } from '@yesid/ui/brand';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';

	let { id, href }: { id: string; href: string } = $props();
	const display = transitDisplay();
	const name = $derived(display.lineName(id));
</script>

<a class="line-link min-h-11 text-primary underline" {href}>
	<RoutePlate code={name.number ?? id} size="md" />
	{#if name.name}<span>{name.name}</span>{/if}
</a>

<style>
	.line-link {
		display: inline-grid;
		grid-template-columns: 3.5rem minmax(min-content, 1fr);
		gap: var(--space-card-gap);
		align-items: center;
		overflow-wrap: normal;
	}
</style>
