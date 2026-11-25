<script module lang="ts">
	export type Reading = string | { value: string; detail?: string };
	export type LineReadingRow = { label: string; href?: string | null; values: Reading[] };
</script>

<script lang="ts">
	import { DataTable, type DataTableColumn } from '@yesid/ui/table';
	import type { Locale } from '#lib/i18n/index.ts';
	import { choose, tally } from '#lib/features/record/recordText.ts';

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
	const columns = $derived<DataTableColumn<LineReadingRow>[]>([
		{ key: 'label', header: headers[0], rowHeader: true, cell: label },
		...headers.slice(1).map((header, index) => ({
			key: String(index),
			header,
			numeric,
			cell: [first, second, third, fourth][index],
		})),
	]);
	const t = (en: string, fr: string) => choose(locale, en, fr);
</script>

{#snippet first(row: LineReadingRow)}{@render reading(row.values[0])}{/snippet}
{#snippet second(row: LineReadingRow)}{@render reading(row.values[1])}{/snippet}
{#snippet third(row: LineReadingRow)}{@render reading(row.values[2])}{/snippet}
{#snippet fourth(row: LineReadingRow)}{@render reading(row.values[3])}{/snippet}
{#snippet label(row: LineReadingRow)}
	{#if row.href}<a
			class="inline-flex min-h-11 min-w-11 items-center text-primary underline"
			href={row.href}>{row.label}</a
		>
	{:else}<span class="inline-flex min-h-11 items-center">{row.label}</span>{/if}
{/snippet}
{#snippet reading(item: Reading)}
	{#if typeof item === 'string'}{item}{:else}
		{item.value}
		{#if item.detail}<span class="block text-small text-muted-foreground">{item.detail}</span>{/if}
	{/if}
{/snippet}
<DataTable
	caption={title}
	{columns}
	{rows}
	pageSize={rows.length > pageSize ? pageSize : undefined}
	key={(row, index) => row.label + '/' + index}
	responsive={{ mode: 'scroll', minWidth: headers.length > 4 ? '35rem' : '15rem' }}
	pageLabels={{
		showing: (shown, total) =>
			t(
				`Showing ${tally(shown, locale)} of ${tally(total, locale)}`,
				`${tally(shown, locale)} sur ${tally(total, locale)}`,
			),
		more: (count) =>
			t(`Show ${tally(count, locale)} more`, `Afficher ${tally(count, locale)} de plus`),
	}}
/>
