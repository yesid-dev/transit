<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title,
		headers,
		rows,
		rowHrefs,
		wide = false,
		rowLabel,
		stack = false,
	}: {
		title: string;
		headers: string[];
		rows: string[][];
		rowHrefs?: string[];
		wide?: boolean;
		rowLabel?: Snippet<[string]>;
		stack?: boolean;
	} = $props();
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex (The wide table must be scrollable with a keyboard.) -->
<div
	class="table-scroll"
	class:stack
	role={wide ? 'region' : undefined}
	aria-label={wide ? title : undefined}
	tabindex={wide ? 0 : undefined}
>
	<table role={stack ? 'table' : undefined}>
		<caption class="sr-only">{title}</caption>
		<thead role={stack ? 'rowgroup' : undefined}
			><tr role={stack ? 'row' : undefined}
				>{#each headers as header (header)}<th scope="col" role={stack ? 'columnheader' : undefined}
						>{header}</th
					>{/each}</tr
			></thead
		>
		<tbody role={stack ? 'rowgroup' : undefined}>
			{#each rows as [label, ...values], index (index)}
				<tr role={stack ? 'row' : undefined}
					><th scope="row" role={stack ? 'rowheader' : undefined}>
						{#if rowLabel}{@render rowLabel(label)}{:else if rowHrefs?.[index]}<a
								href={rowHrefs[index]}>{label}</a
							>{:else}{label}{/if}
					</th>{#each values as value, column (column)}<td role={stack ? 'cell' : undefined}>
							{#if stack}<span class="stack-label" aria-hidden="true">{headers[column + 1]}</span
								>{/if}
							{value}</td
						>{/each}</tr
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
	.stack-label {
		display: none;
	}
	@media (max-width: 640px) {
		.stack thead {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip-path: inset(50%);
		}
		.stack :is(table, tbody, tr, th, td) {
			display: block;
		}
		.stack tr {
			padding-block: 0.5rem;
			border-bottom: 1px solid var(--border);
		}
		.stack :is(th, td) {
			border-bottom: 0;
			padding-block: 0.25rem;
			overflow-wrap: anywhere;
		}
		.stack-label {
			display: block;
			color: var(--muted-foreground);
		}
	}
</style>
