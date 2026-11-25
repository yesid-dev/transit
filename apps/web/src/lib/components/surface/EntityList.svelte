<script lang="ts" generics="T">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn } from '#lib/utils/index.ts';

	interface EntityListProps extends Omit<HTMLAttributes<HTMLUListElement>, 'children'> {
		items: readonly T[];
		key: (item: T) => string;
		row: Snippet<[T]>;
		class?: string;
	}

	let { items, key, row, class: className, ...restProps }: EntityListProps = $props();

	const visible = $derived(items.slice(0, 200));
</script>

<div class="entity-list-container">
	<ul class={cn('entity-list', className)} data-slot="entity-list" {...restProps}>
		{#each visible as item (key(item))}<li class="entity-list-item">
				{@render row(item)}
			</li>{/each}
	</ul>
</div>

<style>
	.entity-list-container {
		container-type: inline-size;
	}
	.entity-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}
	.entity-list-item:not(:last-child) {
		border-bottom: 1px solid var(--border-subtle, var(--border));
	}
	.entity-list-item {
		min-width: 0;
	}
</style>
