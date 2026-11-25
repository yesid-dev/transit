<script module lang="ts">
	import type { DataTableColumn } from '@yesid/ui/table';

	export type RecordTableRow = {
		id: string;
		href: string;
		label: string;
		plate?: string;
		scheduleOnly?: boolean;
		detail?: string;
	};

	export type RecordTableSort = {
		key: string;
		direction: 'asc' | 'desc';
		onSort: (key: string) => void;
		onSelect: (key: string) => void;
		label: (header: string) => string;
		choices: readonly { key: string; label: string }[];
		choiceLabel: string;
		nameKey?: string;
	};

	type Column<Row> = DataTableColumn<Row>;
</script>

<script lang="ts" generics="Row extends RecordTableRow">
	import { SegmentedChoice } from '@yesid/ui/brand';
	import { DataTable } from '@yesid/ui/table';
	import { intl, type Locale } from '#lib/i18n/index.ts';
	import RecordTableName from './RecordTableName.svelte';

	let {
		locale,
		title,
		rowHeader,
		rows,
		columns = [],
		value,
		sort,
		plates = false,
	}: {
		locale: Locale;
		title: string;
		rowHeader: string;
		rows: readonly Row[];
		columns?: readonly Column<Row>[];
		value?: string;
		sort?: RecordTableSort;
		plates?: boolean;
	} = $props();
	const allColumns = $derived<Column<Row>[]>([
		{
			key: sort?.nameKey ?? 'name',
			header: rowHeader,
			rowHeader: true,
			sortable: !!sort,
			cell: nameCell,
		},
		...columns,
	]);
	const number = $derived(intl.number(locale));
	const pageLabels = $derived({
		showing: (shown: number, total: number) =>
			locale === 'fr'
				? `${number.format(shown)} sur ${number.format(total)} affichées`
				: `Showing ${number.format(shown)} of ${number.format(total)}`,
		more: (count: number) =>
			locale === 'fr'
				? `Afficher ${number.format(count)} de plus`
				: `Show ${number.format(count)} more`,
	});
</script>

{#snippet nameCell(row: Row)}
	<RecordTableName {row} {plates} />
{/snippet}
{#if sort}
	<div class="sort-choices mb-2 flex flex-wrap items-center gap-2">
		<span>{sort.choiceLabel}</span>
		<SegmentedChoice
			label={sort.choiceLabel}
			options={sort.choices.map((choice) =>
				choice.key === sort.key
					? { ...choice, compactLabel: choice.label + (sort.direction === 'asc' ? ' ↑' : ' ↓') }
					: choice,
			)}
			value={sort.key}
			onSelect={sort.onSelect}
		/>
	</div>
{/if}

<DataTable
	caption={title}
	columns={allColumns}
	{rows}
	key={(row) => row.id}
	{sort}
	onSort={sort?.onSort}
	sortLabels={sort ? { by: sort.label } : undefined}
	pageSize={sort || rows.length > 20 ? 20 : undefined}
	{pageLabels}
	responsive={{ mode: 'rows', primary: sort?.nameKey ?? 'name', value: value ?? '' }}
/>
