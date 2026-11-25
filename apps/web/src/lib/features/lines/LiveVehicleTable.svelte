<script lang="ts">
	import { StatusMark } from '@yesid/ui/brand';
	import { DataTable, type DataTableColumn } from '@yesid/ui/table';
	import type { Locale } from '#lib/i18n/index.ts';
	import { delayReading, relativeReportAge, searchCount } from '#lib/site/presenter.ts';
	import { liveDelayLabels } from '#lib/site/presenter.ts';
	import StateMark from '../record/StateMark.svelte';
	import { choose } from '../record/recordText.ts';
	import type { LiveVehicleRow } from './lineLiveReadings.ts';

	type Row = LiveVehicleRow & {
		href?: string;
		destination?: string | null;
		nextStop?: { name: string; href: string };
	};
	let { rows, locale, now, title }: { rows: Row[]; locale: Locale; now: number; title: string } =
		$props();
	const t = (en: string, fr: string) => choose(locale, en, fr);

	const number = (count: number) => searchCount(count, locale);
	const columns = $derived<DataTableColumn<Row>[]>([
		{ key: 'status', header: t('Status', 'État'), cell: status },
		{ key: 'vehicle', header: t('Vehicle', 'Véhicule'), cell: vehicle, rowHeader: true },
		{ key: 'next', header: t('Next stop', 'Prochain arrêt'), cell: next },
		{ key: 'last', header: t('Last report', 'Dernier signalement'), cell: last, numeric: true },
	]);
</script>

{#snippet status(row: Row)}
	<StatusMark status={row.status} label={liveDelayLabels(locale)[row.status]} />
	{#if row.delay !== null}
		<span class="text-small text-muted-foreground">{delayReading(row.delay, locale)}</span>
	{/if}
{/snippet}

{#snippet vehicle(row: Row)}
	{#if row.href}
		<a class="inline-flex min-h-11 min-w-11 items-center text-primary underline" href={row.href}>
			{t('Vehicle', 'Véhicule')}
			{row.id}
		</a>
	{:else}
		<span>{t('Vehicle', 'Véhicule')} {row.id}</span>
	{/if}
	{#if row.destination}<span class="block text-small text-muted-foreground">{row.destination}</span
		>{/if}
{/snippet}

{#snippet next(row: Row)}
	{#if row.nextStop}
		<a
			class="inline-flex min-h-11 min-w-11 items-center text-primary underline"
			href={row.nextStop.href}
		>
			{row.nextStop.name}
		</a>
	{:else}
		<StateMark state="unknown" {locale} />
	{/if}
{/snippet}

{#snippet last(row: Row)}
	{#if row.reportedAt !== null}
		{relativeReportAge((now - row.reportedAt) / 1000, locale)}
	{:else}
		<StateMark state="unknown" {locale} />
	{/if}
{/snippet}

{#if rows.some(({ delay }) => delay === null)}
	<p class="mb-3 text-small text-muted-foreground">
		{t(
			'Delay unknown means the vehicle reported a position without a usable delay.',
			'Retard inconnu signifie que le véhicule a transmis sa position sans donnée de retard utilisable.',
		)}
	</p>
{/if}
<DataTable
	caption={title}
	{columns}
	{rows}
	key={(row) => row.id}
	responsive={{ mode: 'scroll', minWidth: '38rem' }}
	pageSize={20}
	pageLabels={{
		showing: (shown, total) =>
			t(`Showing ${number(shown)} of ${number(total)}`, `${number(shown)} sur ${number(total)}`),
		more: (count) => t(`Show ${number(count)} more`, `Afficher ${number(count)} de plus`),
	}}
/>
