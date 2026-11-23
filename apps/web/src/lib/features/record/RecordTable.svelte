<script lang="ts">
	import { DataTable, type DataTableColumn } from '@yesid/ui/table';
	import { createRawSnippet, type Snippet } from 'svelte';

	let {
		title,
		headers,
		rows,
		rowHrefs,
		wide = false,
		rowLabel,
		stack = false,
		heatLevels,
	}: {
		title: string;
		headers: string[];
		rows: string[][];
		rowHrefs?: string[];
		wide?: boolean;
		rowLabel?: Snippet<[string, number]>;
		stack?: boolean;
		heatLevels?: readonly (readonly (number | null)[])[];
	} = $props();

	type Row = { values: string[]; index: number };
	const tableRows = $derived(rows.map((values, index) => ({ values, index })));
	const escape = (value: string) =>
		value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

	// Record answers have runtime-defined columns. Each DataTable column needs its own snippet.
	function textCell(column: number) {
		return createRawSnippet<[Row]>((readRow) => {
			const value = () => readRow().values[column] ?? '';
			const style = () => {
				const tier = heatLevels?.[readRow().index]?.[column - 1];
				return tier == null
					? ''
					: `background:var(--dataviz-heatmap-neutral-${tier});color:var(--dataviz-heatmap-neutral-ink-${tier});display:block;padding:0.25em;border-radius:var(--radius-sm)`;
			};
			return {
				render: () => `<span style="${style()}">${escape(value())}</span>`,
				setup: (element) =>
					$effect.root(() => {
						$effect(() => {
							element.textContent = value();
							element.setAttribute('style', style());
						});
					}),
			};
		});
	}

	const columns = $derived(
		headers.map(
			(header, column): DataTableColumn<Row> =>
				column === 0
					? { key: 'label', header, rowHeader: true, cell: labelCell }
					: { key: String(column), header, cell: textCell(column) },
		),
	);
</script>

{#snippet labelCell({ values, index }: Row)}
	{@const label = values[0] ?? ''}
	{#if rowLabel}
		{@render rowLabel(label, index)}
	{:else if rowHrefs?.[index]}
		<a class="inline-flex min-h-6 items-center" href={rowHrefs[index]}>{label}</a>
	{:else}
		{label}
	{/if}
{/snippet}

<DataTable
	caption={title}
	class="record-evidence-table"
	{columns}
	rows={tableRows}
	key={(row) => String(row.index)}
	responsive={wide
		? { mode: 'scroll', minWidth: '38rem' }
		: { mode: 'stack', at: stack ? 'tablet' : 'compact' }}
/>

<style>
	:global(.record-evidence-table[data-responsive='stack']) {
		container-type: inline-size;
	}

	/* Long localized evidence labels need the full cell width on narrow cards. */
	@container (inline-size < 22rem) {
		:global(
			.record-evidence-table[data-slot='data-table-frame'][data-responsive='stack']
				.data-table
				tbody
				:is(th, td)
		) {
			grid-template-columns: minmax(0, 1fr);
			row-gap: 0.125rem;
		}

		:global(
			.record-evidence-table[data-slot='data-table-frame'][data-responsive='stack']
				.data-table
				tbody
				.data-table-cell-content
		) {
			grid-column: 1;
		}
	}
</style>
