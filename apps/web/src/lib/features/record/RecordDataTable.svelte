<script module lang="ts">
	import type { DataTableColumn } from '@yesid/ui/table';

	export type RecordTableRow = {
		id: string;
		label: string;
		href?: string;
		plate?: { code: string; scheduleOnly?: boolean };
		leadingCode?: { text: string; outline?: boolean };
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

	/**
	 * The phone row: line 1 holds the plate or code box, the linked name, `after` (inline plates)
	 * and the main value in bold at the right; line 2 is one muted sentence of the secondary facts.
	 * No column name repeats in a row. `empty` rows have no value: their sentence follows the name.
	 * The row's `detail` is not printed under the name: include it in `line` when it matters.
	 * `before` precedes the name (a rank); `below` follows the sentence on its own line (a range).
	 */
	export type RecordPhoneRow<Row> = {
		line?: (row: Row) => string | null | undefined;
		before?: Snippet<[Row]>;
		below?: Snippet<[Row]>;
		value?: Snippet<[Row]>;
		after?: Snippet<[Row]>;
		code?: (row: Row) => string | null | undefined;
		empty?: (row: Row) => boolean;
	};

	type Column<Row> = DataTableColumn<Row>;
</script>

<script lang="ts" generics="Row extends RecordTableRow">
	import { SegmentedChoice } from '@yesid/ui/brand';
	import { Button } from '@yesid/ui/button';
	import type { Snippet } from 'svelte';
	import { DataTable } from '@yesid/ui/table';
	import { intl, type Locale } from '#lib/i18n/index.ts';
	import PhoneSwitch from './PhoneSwitch.svelte';
	import RecordTableName from './RecordTableName.svelte';

	/**
	 * Pass keyed rows in display order and a caption. The table owns the linked row heading
	 * (reserved key `name`), the shared plate track, compact rows and paging in groups of 20.
	 * Supply kit columns for readings, marking figures numeric and using RecordTableValue for
	 * values and states. `value` names the column paired with the name on a narrow screen.
	 * Use `scrollMinWidth` for a table that needs to keep its columns at small widths.
	 * Use `stackAt` to stack each row into labelled key/value rows below the kit breakpoint.
	 * Optional `pageSize` and `rowHeading` preserve established page sizes and row-heading content.
	 * Use `pageSize={0}` when the caller fetches additional rows a page at a time.
	 * `leadingColumn` puts an identifier before the name on wide screens.
	 * `nameWidth` reserves room for a custom row heading on wide screens.
	 * When sorting is enabled, the caller reads and writes the URL and supplies the resulting
	 * order and direction. Headers request a direction change; optional choices select a column.
	 * `phone` turns each row into the phone row pattern (see RecordPhoneRow) when the table is at
	 * most 28rem wide, through PhoneSwitch.
	 */
	let {
		locale,
		title,
		rowHeader,
		rows,
		columns = [],
		leadingColumn,
		nameWidth,
		value,
		sort,
		scrollMinWidth,
		stackAt,
		pageSize,
		rowHeading,
		phone,
	}: {
		locale: Locale;
		title: string;
		rowHeader: string;
		rows: readonly Row[];
		columns?: readonly Column<Row>[];
		leadingColumn?: Column<Row>;
		nameWidth?: string;
		value?: string;
		sort?: RecordTableSort;
		scrollMinWidth?: string;
		stackAt?: 'compact' | 'tablet';
		pageSize?: number;
		rowHeading?: Snippet<[Row]>;
		phone?: RecordPhoneRow<Row>;
	} = $props();
	const allColumns = $derived<Column<Row>[]>([
		...(leadingColumn ? [leadingColumn] : []),
		{
			key: 'name',
			header: rowHeader,
			rowHeader: true,
			sortable: !!sort,
			width: nameWidth ?? (sort ? 'max(12ch, calc(100cqi - 75ch))' : undefined),
			cell: nameCell,
		},
		...columns,
	]);
	const valueColumn = $derived(columns.find(({ key }) => key === value));
	const phoneColumns = $derived<Column<Row>[]>([
		{
			key: 'name',
			header: rowHeader,
			rowHeader: true,
			sortable: !!sort && !sort.choices,
			cell: phoneCell,
		},
	]);
	const plates = $derived(
		rows.some(({ plate, leadingCode }) => plate !== undefined || leadingCode !== undefined),
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
{#snippet phoneCell(row: Row)}
	{@const code = phone?.code?.(row)}
	{@const line = phone?.line?.(row)}
	{@const empty = phone?.empty?.(row) ?? false}
	{@const named = { ...row, detail: undefined }}
	<div class="phone-row">
		<div class="phone-head" class:ranked={!!phone?.before}>
			{#if phone?.before}<span class="phone-before">{@render phone.before(row)}</span>{/if}
			<div class="phone-name">
				{#if code}<span class="phone-code">{code}</span>{/if}
				<RecordTableName row={named} {plates} columnCount={1} plateOnName />
				{#if phone?.after}<span class="phone-after">{@render phone.after(row)}</span>{/if}
				{#if empty && line}<span class="phone-line">{line}</span>{/if}
			</div>
			{#if !empty && (phone?.value || valueColumn)}
				<span class="phone-value"
					>{#if phone?.value}{@render phone.value(
							row,
						)}{:else if valueColumn}{@render valueColumn.cell(row)}{/if}</span
				>
			{/if}
		</div>
		{#if line && !empty}<p class="phone-line">{line}</p>{/if}
		{#if phone?.below}{@render phone.below(row)}{/if}
	</div>
{/snippet}
{#snippet wideTable()}
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
			: stackAt
				? { mode: 'stack', at: stackAt }
				: { mode: 'rows', primary: 'name', value: value ?? '' }}
	/>
{/snippet}
{#if sort?.choices}
	{@const options = sort.choices.options.map((choice) =>
		choice.key === sort.key
			? { ...choice, compactLabel: choice.label + (sort.direction === 'asc' ? ' ↑' : ' ↓') }
			: choice,
	)}
	<div class="sort-choice-frame" class:with-phone={!!phone}>
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
			{#if phone}
				<!-- When the choices no longer fit (large text), each one is a button of its own. -->
				<div class="sort-stack">
					{#each sort.choices.options as choice (choice.key)}
						{@const active = choice.key === sort.key}
						<Button
							class="min-h-11"
							variant={active ? 'default' : 'outline'}
							size="sm"
							wrap
							aria-pressed={active}
							onclick={() => (active ? sort.onSort(sort.key) : sort.choices?.onSelect(choice.key))}
							>{choice.label}{active ? (sort.direction === 'asc' ? ' ↑' : ' ↓') : ''}</Button
						>
					{/each}
				</div>
			{/if}
			{#if phone && sortedHeader}
				<!-- Phone rows carry no column headers: this button reverses the order there. -->
				<span class="sort-reverse">
					<Button
						class="min-h-11"
						variant="outline"
						size="sm"
						wrap
						onclick={() => sort.onSort(sort.key)}>{sortHeaderLabel(sortedHeader)}</Button
					>
				</span>
			{/if}
		</div>
	</div>
{/if}

{#if phone}
	<PhoneSwitch wide={wideTable}>
		{#snippet narrow()}
			<DataTable
				caption={title}
				columns={phoneColumns}
				{rows}
				key={(row) => row.id}
				{sort}
				onSort={sort?.onSort}
				sortLabels={sort ? { by: sortHeaderLabel } : undefined}
				pageSize={page}
				{pageLabels}
				responsive={{ mode: 'rows', primary: 'name', value: '' }}
			/>
		{/snippet}
	</PhoneSwitch>
{:else}
	{@render wideTable()}
{/if}

<style>
	.phone-row {
		display: grid;
		gap: 0.125rem;
		min-inline-size: 0;
	}
	.phone-head {
		display: grid;
		/* A long state as the value wraps within half the row; the name keeps the rest. */
		grid-template-columns: minmax(0, 1fr) fit-content(50%);
		align-items: baseline;
		column-gap: 0.5rem;
	}
	.phone-head.ranked {
		grid-template-columns: auto minmax(0, 1fr) fit-content(50%);
	}
	.phone-name {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		column-gap: 0.5rem;
		row-gap: 0.125rem;
		min-inline-size: 0;
	}
	/* The name keeps its longest word and its tap size; the row wraps around it. */
	.phone-name > :global(.name-cell) {
		flex: 0 1 auto;
		min-inline-size: min-content;
	}
	.phone-code {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding-inline: 0.25em;
		font-family: var(--font-mono);
		font-size: var(--text-small);
	}
	.phone-before {
		font-family: var(--font-mono);
		font-size: var(--text-small);
		font-variant-numeric: tabular-nums;
	}
	.phone-after {
		display: inline-flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		/* A plate wraps as a whole, never between its digits. */
		white-space: nowrap;
	}
	.phone-value {
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		text-align: end;
	}
	.phone-line {
		color: var(--muted-foreground);
		font-size: var(--text-small);
		font-weight: 400;
		line-height: 1.35;
	}
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
	.sort-stack {
		display: none;
	}
	@container (inline-size < 8rem) {
		.sort-choice-frame:not(.with-phone) .sort-choices {
			display: none;
		}
		.with-phone :is(.sort-choice-default, .sort-choice-grid, .sort-reverse) {
			display: none;
		}
		.with-phone .sort-stack {
			display: grid;
			gap: 0.5rem;
			inline-size: 100%;
		}
	}
	@container (inline-size > 28rem) {
		.sort-reverse {
			display: none;
		}
	}
</style>
