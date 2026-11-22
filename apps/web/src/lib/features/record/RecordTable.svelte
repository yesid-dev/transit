<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title,
		headers,
		rows,
		wide = false,
		rowLabel,
	}: {
		title: string;
		headers: string[];
		rows: string[][];
		wide?: boolean;
		rowLabel?: Snippet<[string]>;
	} = $props();
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex (The wide table must be scrollable with a keyboard.) -->
<div
	class="table-scroll"
	role={wide ? 'region' : undefined}
	aria-label={wide ? title : undefined}
	tabindex={wide ? 0 : undefined}
>
	<table>
		<caption class="sr-only">{title}</caption>
		<thead
			><tr
				>{#each headers as header (header)}<th scope="col">{header}</th>{/each}</tr
			></thead
		>
		<tbody>
			{#each rows as [label, ...values], index (index)}
				<tr
					><th scope="row"
						>{#if rowLabel}{@render rowLabel(label)}{:else}{label}{/if}</th
					>{#each values as value, column (column)}<td>{value}</td>{/each}</tr
				>
			{/each}
		</tbody>
	</table>
</div>

<style>
	.table-scroll {
		max-width: 100%;
		overflow-x: auto;
	}
	.table-scroll[role='region'] table {
		min-width: 38rem;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--text-small);
	}
	th,
	td {
		padding: 0.5rem 0.375rem;
		border-bottom: 1px solid var(--border);
		text-align: start;
	}
	td {
		font-variant-numeric: tabular-nums;
	}
</style>
