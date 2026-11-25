<script module lang="ts">
	import type { DataTableColumn } from '@yesid/ui/table';

	export type RecordTableRow = {
		id: string;
		label: string;
		href?: string;
		plate?: { code: string; scheduleOnly?: boolean };
		detail?: string;
	};

	export type RecordTableSort = {
		key: string;
		direction: 'asc' | 'desc';
		onSort: (key: string) => void;
		choices?: {
			options: readonly { key: string; label: string }[];
			onSelect: (key: string) => void;
		};
	};

	type Column<Row> = DataTableColumn<Row>;
</script>

<script lang="ts" generics="Row extends RecordTableRow">
	import { SegmentedChoice } from '@yesid/ui/brand';
	import { DataTable } from '@yesid/ui/table';
	import { intl, type Locale } from '#lib/i18n/index.ts';
	import RecordTableName from './RecordTableName.svelte';

	/**
	 * Pass keyed rows in display order and a caption. The table owns the linked row heading
	 * (reserved key `name`), the shared plate track, compact rows and paging in groups of 20.
	 * Supply kit columns for readings, marking figures numeric and using RecordTableValue for
	 * values and states. `value` names the column paired with the name on a narrow screen.
	 * When sorting is enabled, the caller reads and writes the URL and supplies the resulting
	 * order and direction. Headers request a direction change; optional choices select a column.
	 */
	let {
		locale,
		title,
		rowHeader,
		rows,
		columns = [],
		value,
		sort,
	}: {
		locale: Locale;
		title: string;
		rowHeader: string;
		rows: readonly Row[];
		columns?: readonly Column<Row>[];
		value?: string;
		sort?: RecordTableSort;
	} = $props();
	const allColumns = $derived<Column<Row>[]>([
		{
			key: 'name',
			header: rowHeader,
			rowHeader: true,
			sortable: !!sort,
			cell: nameCell,
		},
		...columns,
	]);
	const plates = $derived(rows.some(({ plate }) => plate !== undefined));
	const number = $derived(intl.number(locale));
	const sortBy = $derived(locale === 'fr' ? 'Trier par' : 'Sort by');
	const pageLabels = $derived({
		showing: (shown: number, total: number) =>
			locale === 'fr'
				? `${number.format(shown)} sur ${number.format(total)}`
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
{#if sort?.choices}
	<div class="mb-2 flex flex-wrap items-center gap-2">
		<span class="basis-full sm:basis-auto">{sortBy}</span>
		<SegmentedChoice
			label={sortBy}
			options={sort.choices.options.map((choice) =>
				choice.key === sort.key
					? { ...choice, compactLabel: choice.label + (sort.direction === 'asc' ? ' ↑' : ' ↓') }
					: choice,
			)}
			value={sort.key}
			onSelect={sort.choices.onSelect}
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
	sortLabels={sort ? { by: (header) => `${sortBy} ${header}` } : undefined}
	pageSize={sort || rows.length > 20 ? 20 : undefined}
	{pageLabels}
	responsive={{ mode: 'rows', primary: 'name', value: value ?? '' }}
/>
