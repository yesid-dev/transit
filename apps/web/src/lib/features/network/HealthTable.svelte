<script lang="ts">
	import { DataTable, type DataTableColumn } from '@yesid/ui/table';
	import { createRawSnippet } from 'svelte';
	import type { Locale } from '#lib/i18n/index.ts';
	import { choose, tally } from '../record/recordText.ts';

	let {
		title,
		headers,
		rows,
		numeric = [],
		paging,
	}: {
		title: string;
		headers: string[];
		rows: string[][];
		numeric?: number[];
		paging?: { size: number; locale: Locale };
	} = $props();

	type Row = { cells: string[]; index: number };
	const tableRows = $derived(rows.map((cells, index) => ({ cells, index })));
	const columns = $derived(
		headers.map(
			(header, index): DataTableColumn<Row> => ({
				key: String(index),
				header,
				...(index === 0 ? { rowHeader: true } : {}),
				numeric: numeric.includes(index),
				cell: createRawSnippet<[Row]>((row) => {
					const value = () => row().cells[index] ?? '';
					return {
						render: () => {
							const rowLabelClass =
								paging && index === 0 ? ' class="inline-flex min-h-11 items-center"' : '';
							const escaped = value()
								.replaceAll('&', '&amp;')
								.replaceAll('<', '&lt;')
								.replaceAll('>', '&gt;');
							return `<span${rowLabelClass}>${escaped}</span>`;
						},
						setup: (element) =>
							$effect.root(() => {
								$effect(() => {
									element.textContent = value();
								});
							}),
					};
				}),
			}),
		),
	);
</script>

<DataTable
	caption={title}
	{columns}
	rows={tableRows}
	key={(row) => String(row.index)}
	responsive={{ mode: 'scroll', minWidth: '24rem' }}
	pageSize={paging?.size}
	pageLabels={paging && {
		showing: (shown, total) =>
			choose(
				paging.locale,
				`Showing ${tally(shown, paging.locale)} of ${tally(total, paging.locale)}`,
				`${tally(shown, paging.locale)} sur ${tally(total, paging.locale)}`,
			),
		more: (count) =>
			choose(
				paging.locale,
				`Show ${tally(count, paging.locale)} more`,
				`Afficher ${tally(count, paging.locale)} de plus`,
			),
	}}
/>
