<script lang="ts">
	import { stopDisplayName } from '#lib/site/transitDisplay.ts';
	import { StatusMark } from '@yesid/ui/brand';
	import type { DataTableColumn } from '@yesid/ui/table';
	import type { Locale } from '#lib/i18n/index.ts';
	import {
		lastReport,
		liveDelayLabels,
		liveStatusWords,
		relativeReportAge,
		rowSentence,
	} from '#lib/site/presenter.ts';
	import RecordDataTable from '../record/RecordDataTable.svelte';
	import StateMark from '../record/StateMark.svelte';
	import { choose } from '../record/recordText.ts';
	import type { LiveVehicleRow } from './lineLiveReadings.ts';

	type Row = LiveVehicleRow & {
		href?: string;
		destination?: string | null;
		nextStop?: { name: string; href: string };
	};
	let {
		rows,
		locale,
		now,
		title,
		noHeading,
	}: {
		rows: Row[];
		locale: Locale;
		now: number;
		title: string;
		/** Said once under the table when the feed gives no direction or next stop. */
		noHeading?: string;
	} = $props();
	const t = (en: string, fr: string) => choose(locale, en, fr);

	// A feed that gives no vehicle a next stop (OC Transpo) loses the column, not each row.
	const stops = $derived(rows.some(({ stop }) => stop !== null));
	const tableRows = $derived(
		rows.map((row) => ({
			...row,
			label: t(`Vehicle ${row.id}`, `Véhicule ${row.id}`),
			detail: row.destination ?? undefined,
		})),
	);
	type TableRow = (typeof tableRows)[number];
	const columns = $derived<DataTableColumn<TableRow>[]>([
		{ key: 'status', header: t('Status', 'État'), cell: status },
		...(stops ? [{ key: 'next', header: t('Next stop', 'Prochain arrêt'), cell: next }] : []),
		{ key: 'last', header: t('Last report', 'Dernier signalement'), cell: last, numeric: true },
	]);
	const report = (row: Row) =>
		row.reportedAt === null ? null : relativeReportAge((now - row.reportedAt) / 1000, locale);
</script>

{#snippet status(row: Row)}
	<StatusMark
		status={row.status}
		{...liveStatusWords(row.status, liveDelayLabels(locale)[row.status], row.delay, locale)}
	/>
{/snippet}

{#snippet next(row: Row)}
	{#if row.nextStop}
		<a
			class="inline-flex min-h-11 min-w-11 items-center text-primary underline"
			href={row.nextStop.href}
		>
			{stopDisplayName(row.nextStop.name)}
		</a>
	{:else}
		<StateMark state="unknown" {locale} />
	{/if}
{/snippet}

{#snippet nextStopLine(row: Row)}
	{#if row.nextStop}<span class="text-small"
			>{t('Next stop', 'Prochain arrêt')}{t(': ', '\u00a0: ')}<a
				class="text-primary underline"
				href={row.nextStop.href}>{stopDisplayName(row.nextStop.name)}</a
			></span
		>{/if}
{/snippet}

{#snippet last(row: Row)}
	{@const age = report(row)}
	{#if age !== null}{age}{:else}<StateMark state="unknown" {locale} />{/if}
{/snippet}

{#if rows.some(({ delay }) => delay === null)}
	<p class="mb-3 text-small text-muted-foreground">
		{t(
			'Delay unknown means the vehicle reported a position without a usable delay.',
			'Retard inconnu signifie que le véhicule a transmis sa position sans donnée de retard utilisable.',
		)}
	</p>
{/if}
<RecordDataTable
	{locale}
	{title}
	rowHeader={t('Vehicle', 'Véhicule')}
	{columns}
	rows={tableRows}
	value="status"
	phone={{
		line: (row) => {
			const age = report(row);
			return rowSentence([row.destination, age && lastReport(age, locale)], locale);
		},
		below: nextStopLine,
	}}
/>
{#if noHeading}<p class="mt-3 text-small text-muted-foreground">{noHeading}</p>{/if}
