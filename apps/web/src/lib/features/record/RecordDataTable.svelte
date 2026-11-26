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
	 * `after` renders items (plates) that flow after the name like words, separated by spaces;
	 * wrap each in a no-wrap span so it never breaks inside.
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
	import { RoutePlate, SegmentedChoice } from '@yesid/ui/brand';
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
{#snippet phoneValue(row: Row)}
	{#if phone?.value}{@render phone.value(row)}{:else if valueColumn}{@render valueColumn.cell(
			row,
		)}{/if}
{/snippet}
{#snippet phoneCell(row: Row)}
	{@const code = phone?.code?.(row)}
	{@const line = phone?.line?.(row)}
	{@const empty = phone?.empty?.(row) ?? false}
	{@const valued = !empty && !!(phone?.value || valueColumn)}
	{@const lead = !!(phone?.before || code)}
	<!-- A hanging indent, as in the wireframe: the rank or code box, then the text column where the
	name wraps with its plates and the row's sentence under it, then the value. -->
	<div class="phone-row" class:lead>
		{#if lead}<span class="phone-lead"
				>{#if phone?.before}<span class="phone-before">{@render phone.before(row)}</span
					>{/if}{#if code}<span class="phone-code">{code}</span>{/if}</span
			>{/if}
		<div class="phone-text">
			{#if row.href}<a class="phone-link" href={row.href}>{@render phoneName(row)}</a>{:else}<span
					class="phone-link">{@render phoneName(row)}</span
				>{/if}{#if phone?.after}
				<span class="phone-after">{@render phone.after(row)}</span>{/if}{#if empty && line}
				<span class="phone-line">{line}</span>{/if}
		</div>
		{#if valued}<span class="phone-value">{@render phoneValue(row)}</span>{/if}
		{#if line && !empty}<p class="phone-line phone-under">{line}</p>{/if}
		{#if phone?.below}<div class="phone-under">{@render phone.below(row)}</div>{/if}
	</div>
{/snippet}
{#snippet phoneName(row: RecordTableRow)}{#if row.plate}<span class="phone-plate"
			><RoutePlate {...row.plate} /></span
		>{:else if row.leadingCode}<span class="phone-plate" class:phone-code={row.leadingCode.outline}
			>{row.leadingCode.text}</span
		>{/if}<span class="name-label">{row.label}</span>{/snippet}
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
		/* The value keeps at most 30% of the row, so the name's column stays wide enough to read. */
		grid-template-columns: minmax(0, 1fr) fit-content(30%);
		align-items: baseline;
		column-gap: 0.5rem;
		row-gap: 0.125rem;
		min-inline-size: 0;
		line-height: 1.5;
	}
	.phone-row.lead {
		grid-template-columns: auto minmax(0, 1fr) fit-content(30%);
	}
	.phone-lead {
		display: inline-flex;
		gap: 0.5rem;
		align-items: baseline;
	}
	.phone-text {
		min-inline-size: 0;
	}
	.phone-value {
		grid-column: -2;
	}
	/* The sentence and the range bar sit under the name, never under the code box. */
	.phone-under {
		grid-column: 1 / -1;
	}
	.lead > .phone-under {
		grid-column: 2 / -1;
	}
	/* On the narrowest phones (320px) the value moves under the name, in the text column, as the kit's
	own rows mode does below 14rem: beside a code box and a state it would leave the name no room. */
	@container phone-switch (inline-size < 15rem) {
		.phone-row {
			grid-template-columns: minmax(0, 1fr);
		}
		.phone-row.lead {
			grid-template-columns: auto minmax(0, 1fr);
		}
		.phone-row > .phone-value {
			grid-row: 2;
			grid-column: 1;
			text-align: start;
		}
		.phone-row.lead > .phone-value {
			grid-column: 2;
		}
	}
	/* With enlarged text the indent would leave too narrow a column: the sentence takes the row. */
	@container phone-switch (inline-size < 12rem) {
		.lead > .phone-under {
			grid-column: 1 / -1;
		}
	}
	.phone-before {
		min-inline-size: 2ch;
		font-family: var(--font-mono);
		font-size: var(--text-small);
		font-variant-numeric: tabular-nums;
	}
	.phone-code {
		min-inline-size: 6.5ch;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding-inline: 0.25em;
		font-family: var(--font-mono);
		font-size: var(--text-small);
		text-align: center;
	}
	.phone-value {
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		text-align: end;
	}
	/* The name wraps inside the text column; plates follow it as words. Top-aligned, so the row
	lines the code box and the value up with the name's first line, as in the wireframe. */
	.phone-link {
		display: inline-block;
		vertical-align: top;
		/* Padding gives a 44px target; the equal negative margin keeps it out of the layout, so the
		next line starts under the name's last line of text, however many lines it takes. */
		padding-block: calc((var(--size-tap-min) - 1.5em) / 2);
		margin-block: calc((1.5em - var(--size-tap-min)) / 2);
		min-inline-size: min(var(--size-tap-min), 100%);
		max-inline-size: 100%;
		margin-inline-end: 0.25rem;
		overflow-wrap: normal;
	}
	a.phone-link {
		color: var(--primary);
	}
	a.phone-link .name-label {
		text-decoration: underline;
	}
	/* Equal digits keep names of one length on one width, so they wrap at the same place. */
	.phone-link .name-label {
		font-variant-numeric: tabular-nums;
	}
	a.phone-link:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}
	.phone-plate {
		display: inline-block;
		min-inline-size: 3.75em;
		margin-inline-end: 0.375rem;
		white-space: nowrap;
	}
	.phone-plate.phone-code {
		min-inline-size: 0;
	}
	/* Plates are words of the line: each wraps as a whole, never between its digits. */
	.phone-after {
		margin-inline-start: 0.125rem;
		word-spacing: 0.125rem;
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
