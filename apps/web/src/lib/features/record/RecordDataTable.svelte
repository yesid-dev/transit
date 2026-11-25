<script module lang="ts">
	import type { DataTableColumn } from '@yesid/ui/table';

	export type RecordTableRow = {
		id: string;
		label: string;
		href?: string;
		plate?: { code: string; scheduleOnly?: boolean };
		code?: { text: string; outline?: boolean };
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
	import type { Snippet } from 'svelte';
	import RecordTableName from './RecordTableName.svelte';

	/**
	 * Pass keyed rows in display order and a caption. The table owns the linked row heading
	 * (reserved key `name`), the shared plate track, compact rows and paging in groups of 20.
	 * Supply kit columns for readings, marking figures numeric and using RecordTableValue for
	 * values and states. `value` names the column paired with the name on a narrow screen.
	 * Use `scrollMinWidth` for a table that needs to keep its columns at small widths.
	 * Optional `pageSize` and `rowHeading` preserve established page sizes and row-heading content.
	 * Use `pageSize={0}` when the caller fetches additional rows a page at a time.
	 * `leadingColumn` puts an identifier before the name on wide screens.
	 * When sorting is enabled, the caller reads and writes the URL and supplies the resulting
	 * order and direction. Headers request a direction change; optional choices select a column.
	 */
	let {
		locale,
		title,
		rowHeader,
		rows,
		columns = [],
		leadingColumn,
		value,
		sort,
		scrollMinWidth,
		pageSize,
		rowHeading,
	}: {
		locale: Locale;
		title: string;
		rowHeader: string;
		rows: readonly Row[];
		columns?: readonly Column<Row>[];
		leadingColumn?: Column<Row>;
		value?: string;
		sort?: RecordTableSort;
		scrollMinWidth?: string;
		pageSize?: number;
		rowHeading?: Snippet<[Row]>;
	} = $props();
	const allColumns = $derived<Column<Row>[]>([
		...(leadingColumn ? [leadingColumn] : []),
		{
			key: 'name',
			header: rowHeader,
			rowHeader: true,
			sortable: !!sort,
			width: sort ? 'max(12ch, calc(100cqi - 75ch))' : undefined,
			cell: nameCell,
		},
		...columns,
	]);
	const plates = $derived(
		rows.some(({ plate, code }) => plate !== undefined || code !== undefined),
	);
	const page = $derived(pageSize ?? (sort || rows.length > 20 ? 20 : undefined));
	const number = $derived(intl.number(locale));
	const sortBy = $derived(locale === 'fr' ? 'Trier par' : 'Sort by');
	const sortedHeader = $derived(allColumns.find(({ key }) => key === sort?.key)?.header);

	function sortHeaderLabel(header: string) {
		if (header !== sortedHeader) return `${sortBy} ${header}`;
		return locale === 'fr' ? `Inverser le tri par ${header}` : `Reverse sort by ${header}`;
	}

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
	{#if rowHeading}
		{@render rowHeading(row)}
	{:else if page && !row.href}
		<div class="inline-flex min-h-11 items-center">
			<RecordTableName {row} {plates} columnCount={allColumns.length} />
		</div>
	{:else}
		<RecordTableName {row} {plates} columnCount={allColumns.length} />
	{/if}
{/snippet}
{#if sort?.choices}
	{@const options = sort.choices.options.map((choice) =>
		choice.key === sort.key
			? { ...choice, compactLabel: choice.label + (sort.direction === 'asc' ? ' ↑' : ' ↓') }
			: choice,
	)}
	<div class="sort-choice-frame">
		<div class="sort-choices mb-2 flex flex-wrap items-center gap-2">
			<span class="basis-full sm:basis-auto">{sortBy}</span>
			<div class="sort-choice-default">
				<SegmentedChoice
					label={sortBy}
					{options}
					value={sort.key}
					onSelect={sort.choices.onSelect}
				/>
			</div>
			<div class="sort-choice-grid w-full">
				<SegmentedChoice
					label={sortBy}
					{options}
					value={sort.key}
					onSelect={sort.choices.onSelect}
					variant="joined-grid"
				/>
			</div>
		</div>
	</div>
{/if}

<DataTable
	caption={title}
	columns={allColumns}
	{rows}
	key={(row) => row.id}
	{sort}
	onSort={sort?.onSort}
	sortLabels={sort ? { by: sortHeaderLabel } : undefined}
	pageSize={page}
	{pageLabels}
	responsive={scrollMinWidth
		? { mode: 'scroll', minWidth: scrollMinWidth }
		: { mode: 'rows', primary: 'name', value: value ?? '' }}
/>

<style>
	.sort-choice-frame {
		container-type: inline-size;
	}
	.sort-choice-grid {
		display: none;
	}
	@container (14rem <= inline-size < 24rem) {
		.sort-choice-default {
			display: none;
		}
		.sort-choice-grid {
			display: block;
		}
	}
	/* Column headers retain sorting when the optional choices run out of room. */
	@container (inline-size < 8rem) {
		.sort-choices {
			display: none;
		}
	}
</style>
