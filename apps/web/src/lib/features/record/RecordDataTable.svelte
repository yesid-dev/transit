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
		label: (header: string) => string;
		choices: readonly { key: string; label: string }[];
		choiceLabel: string;
		nameKey?: string;
	};

	type Column<Row> = DataTableColumn<Row>;
</script>

<script lang="ts" generics="Row extends RecordTableRow">
	import { RoutePlate, SegmentedChoice } from '@yesid/ui/brand';
	import { DataTable } from '@yesid/ui/table';
	import { intl, type Locale } from '#lib/i18n/index.ts';

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
	<div class:plates class="name-cell">
		{#if row.plate}
			<RoutePlate code={row.plate} scheduleOnly={row.scheduleOnly} />
		{/if}
		<div class="name-text">
			<a
				href={row.href}
				aria-label={row.plate && row.plate !== row.label
					? row.plate + ' · ' + row.label
					: undefined}>{row.label}</a
			>
			{#if row.detail}<p class="text-muted-foreground">{row.detail}</p>{/if}
		</div>
	</div>
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
			onSelect={sort.onSort}
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
	class="compact-record-table"
	data-has-value={value ? true : undefined}
	responsive={{ mode: 'rows', primary: sort?.nameKey ?? 'name', value: value ?? '' }}
/>

<style>
	.name-cell {
		display: grid;
		align-items: start;
	}
	.plates {
		grid-template-columns: 3.75em minmax(0, 1fr);
		gap: var(--space-card-gap);
	}
	.plates > :global([data-slot='route-plate']) {
		align-self: start;
		justify-self: stretch;
		margin-block-start: 0.5em;
		white-space: nowrap;
	}
	.plates > .name-text {
		grid-column: 2;
	}
	.name-text a {
		display: inline-flex;
		align-items: center;
		min-block-size: 44px;
		min-inline-size: min(44px, 100%);
		color: var(--primary);
		text-decoration: underline;
	}
	.name-text p {
		margin: 0;
	}
	.name-text {
		overflow-wrap: normal;
	}
	.name-text a:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}
	:global(.compact-record-table .data-table) {
		overflow-wrap: normal;
	}
	:global(.compact-record-table .data-table :is(th, td)) {
		vertical-align: middle;
	}
	:global(.compact-record-table + [data-slot='show-more'] button) {
		min-block-size: 44px;
	}
	:global(.compact-record-table button.data-table-sort) {
		overflow-wrap: normal;
	}
	@container yesid-table (max-width: 36rem) {
		:global(.compact-record-table[data-responsive='rows'][data-stack-at='compact'] .data-table),
		:global(
			.compact-record-table[data-responsive='rows'][data-stack-at='compact'] .data-table tbody
		) {
			display: block;
		}
		:global(
			.compact-record-table[data-responsive='rows'][data-stack-at='compact']
				.data-table
				thead[role='rowgroup']
		) {
			display: none;
		}
		:global(
			.compact-record-table[data-responsive='rows'][data-stack-at='compact'] .data-table tbody tr
		) {
			display: flex;
			flex-wrap: wrap;
			align-items: baseline;
			gap: 0 0.75em;
			padding-block: 0.5em;
			border-block-start: 1px solid var(--border);
		}
		:global(
			.compact-record-table[data-responsive='rows'][data-stack-at='compact']
				.data-table
				tbody
				tr
				> :is(th, td)
		) {
			display: flex;
			flex-direction: column;
			align-items: start;
			flex: 1 1 auto;
			padding: 0;
			border: 0;
		}
		:global(
			.compact-record-table[data-responsive='rows'][data-stack-at='compact']
				.data-table
				tbody
				tr
				> [data-row-position='primary']
		) {
			flex: 1 1 100%;
			min-inline-size: 0;
		}
		:global(
			.compact-record-table[data-responsive='rows'][data-stack-at='compact'][data-has-value]
				.data-table
				tbody
				tr
				> [data-row-position='primary']
		) {
			flex: 1 1 60%;
		}
		:global(
			.compact-record-table[data-responsive='rows'][data-stack-at='compact']
				.data-table
				tbody
				tr
				> [data-row-position='value']
		) {
			flex: 0 1 28%;
			align-items: end;
			text-align: end;
		}
		:global(
			.compact-record-table[data-responsive='rows'][data-stack-at='compact'] .data-table-stack-label
		) {
			display: block;
			color: var(--muted-foreground);
			font-size: var(--text-micro);
		}
		:global(
			.compact-record-table[data-responsive='rows'][data-stack-at='compact']
				[data-row-position='primary']
				.data-table-stack-label
		) {
			display: none;
		}
	}
	@container yesid-table (max-width: 16rem) {
		:global(
			.compact-record-table[data-has-value][data-responsive='rows'][data-stack-at='compact']
				.data-table
				tbody
				tr
				> [data-row-position='primary']
		) {
			flex-basis: 100%;
		}
		.plates {
			grid-template-columns: minmax(0, 1fr);
		}
		.plates > .name-text {
			grid-column: 1;
		}
		.plates > :global([data-slot='route-plate']) {
			justify-self: start;
		}
	}
</style>
