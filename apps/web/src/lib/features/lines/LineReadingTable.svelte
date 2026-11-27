<script module lang="ts">
	export type Reading = string | { value: string; detail?: string };
	/** `phone` replaces the generic phone row (first value, then the others as one sentence). */
	export type LineReadingRow = {
		label: string;
		href?: string | null;
		values: Reading[];
		phone?: { value: string; line: string | null };
	};
</script>

<script lang="ts">
	import type { DataTableColumn } from '@yesid/ui/table';
	import type { Locale } from '#lib/i18n/index.ts';
	import { rowSentence } from '#lib/site/presenter.ts';
	import RecordDataTable from '#lib/features/record/RecordDataTable.svelte';

	let {
		title,
		headers,
		rows,
		locale,
		pageSize = 8,
		numeric = true,
	}: {
		title: string;
		headers: string[];
		rows: LineReadingRow[];
		locale: Locale;
		pageSize?: number;
		numeric?: boolean;
	} = $props();
	type Row = LineReadingRow & { id: string; href?: string };
	const tableRows = $derived<Row[]>(
		rows.map((row, index) => ({
			...row,
			id: row.label + '/' + index,
			href: row.href ?? undefined,
		})),
	);
	const columns = $derived<DataTableColumn<Row>[]>(
		headers.slice(1).map((header, index) => ({
			key: String(index),
			header,
			numeric,
			cell: [first, second, third, fourth][index],
		})),
	);
	const text = (item: Reading | undefined) =>
		item === undefined ? '' : typeof item === 'string' ? item : item.value;
	function phoneLine(row: Row) {
		if (row.phone) return row.phone.line;
		const first = row.values[0];
		return rowSentence(
			[
				typeof first === 'object' && first.detail,
				...row.values
					.slice(1)
					.map((item, index) =>
						text(item) ? `${headers[index + 2].toLocaleLowerCase(locale)} ${text(item)}` : null,
					),
			],
			locale,
		);
	}
</script>

{#snippet first(row: Row)}{@render reading(row.values[0])}{/snippet}
{#snippet second(row: Row)}{@render reading(row.values[1])}{/snippet}
{#snippet third(row: Row)}{@render reading(row.values[2])}{/snippet}
{#snippet fourth(row: Row)}{@render reading(row.values[3])}{/snippet}
{#snippet phoneValue(row: Row)}{row.phone?.value ?? text(row.values[0])}{/snippet}
{#snippet reading(item: Reading)}
	{#if typeof item === 'string'}<span class:font-sans={!numeric}>{item}</span>{:else}
		<span class="font-sans">{item.value}</span>
		{#if item.detail}<span class="block font-sans text-small text-muted-foreground"
				>{item.detail}</span
			>{/if}
	{/if}
{/snippet}
<RecordDataTable
	{locale}
	{title}
	rowHeader={headers[0]}
	rows={tableRows}
	{columns}
	value="0"
	pageSize={rows.length > pageSize ? pageSize : undefined}
	scrollMinWidth={headers.length > 4 ? '35rem' : '15rem'}
	phone={{ value: phoneValue, line: phoneLine }}
/>
