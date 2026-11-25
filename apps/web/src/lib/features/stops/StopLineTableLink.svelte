<script lang="ts">
	import { RoutePlate } from '@yesid/ui/brand';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';

	let { id, href, wrap = false }: { id: string; href: string; wrap?: boolean } = $props();
	const display = transitDisplay();
	const name = $derived(display.lineName(id));
</script>

<a class="line-link min-h-11 min-w-11 text-primary underline" class:wrap {href}>
	<RoutePlate code={name.number ?? id} size="md" class={wrap ? 'min-w-0!' : undefined} />
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
	.line-link.wrap {
		grid-template-columns: max-content minmax(0, 1fr);
		gap: 0.5em;
	}
</style>
