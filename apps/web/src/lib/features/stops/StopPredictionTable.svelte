<script lang="ts">
	import { StatusMark } from '@yesid/ui/brand';
	import { DataTable, type DataTableColumn } from '@yesid/ui/table';
	import { localizeHref, type Locale } from '#lib/i18n/index.ts';
	import { departureHref } from '#lib/features/record/departureIdentity.ts';
	import { carryFrameState } from '#lib/site/frameState.ts';
	import { clockTime, delayReading, liveDelayLabels, predictedIn } from '#lib/site/presenter.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { classifyDelay } from '#lib/v1/live/statusBands.ts';
	import { choose, tally } from '../record/recordText.ts';
	import StopLineTableLink from './StopLineTableLink.svelte';
	import type { StopPrediction } from './stopLiveReadings.ts';

	let {
		rows,
		caption,
		locale,
		city,
		url,
		timeZone,
		now,
	}: {
		rows: StopPrediction[];
		caption: string;
		locale: Locale;
		city: string;
		url: URL;
		timeZone: string;
		now: number;
	} = $props();
	const display = transitDisplay();
	const t = (en: string, fr: string) => choose(locale, en, fr);
	const columns = $derived<DataTableColumn<StopPrediction>[]>([
		{ key: 'line', header: t('Line', 'Ligne'), rowHeader: true, cell: line },
		{ key: 'toward', header: t('Toward', 'Vers'), cell: toward },
		{ key: 'scheduled', header: t('Scheduled', 'Horaire'), numeric: true, cell: scheduled },
		{ key: 'expected', header: t('Expected', 'Prévu'), numeric: true, cell: expected },
		{ key: 'status', header: t('Status', 'État'), cell: status },
	]);
</script>

{#snippet line(row: StopPrediction)}
	{#if row.line}
		<StopLineTableLink
			id={row.line}
			href={carryFrameState(
				localizeHref('/lines/' + encodeURIComponent(row.line), locale, city),
				url,
			)}
		/>
	{:else}
		{t('Not published', 'Non publié')}
	{/if}
{/snippet}

{#snippet toward(row: StopPrediction)}
	{row.toward ? display.readName(row.toward, locale) : t('Not published', 'Non publié')}
{/snippet}

{#snippet scheduled(row: StopPrediction)}
	{row.scheduledAt === null
		? t('Unavailable', 'Indisponible')
		: clockTime(new Date(row.scheduledAt), locale, timeZone)}
{/snippet}

{#snippet expected(row: StopPrediction)}
	{@const time = predictedIn(row.predictedAt, now, locale)}
	{@const href =
		row.line && row.start
			? departureHref(url, locale, city, row.line, row.direction, row.start, 'live', row.trip)
			: null}
	{#if href}
		<a class="inline-flex min-h-11 min-w-11 items-center justify-end text-primary underline" {href}
			>{time}</a
		>
	{:else}{time}{/if}
{/snippet}

{#snippet status(row: StopPrediction)}
	{@const band = classifyDelay(row.delay)}
	<StatusMark status={band} label={liveDelayLabels(locale)[band]} />
	{#if row.delay !== null}
		<span class="block text-small text-muted-foreground">{delayReading(row.delay, locale)}</span>
	{/if}
{/snippet}

<DataTable
	{caption}
	{columns}
	{rows}
	key={(row) => row.key}
	responsive={{ mode: 'scroll', minWidth: '36rem' }}
	pageSize={rows.length > 20 ? 20 : undefined}
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
