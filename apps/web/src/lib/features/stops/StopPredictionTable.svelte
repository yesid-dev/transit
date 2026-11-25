<script lang="ts">
	import { StatusMark } from '@yesid/ui/brand';
	import type { DataTableColumn } from '@yesid/ui/table';
	import { localizeHref, type Locale } from '#lib/i18n/index.ts';
	import { departureHref } from '#lib/features/record/departureIdentity.ts';
	import RecordDataTable, { type RecordTableRow } from '../record/RecordDataTable.svelte';
	import RecordTableName from '../record/RecordTableName.svelte';
	import { carryFrameState } from '#lib/site/frameState.ts';
	import { clockTime, delayReading, liveDelayLabels, predictedIn } from '#lib/site/presenter.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { classifyDelay } from '#lib/v1/live/statusBands.ts';
	import { choose } from '../record/recordText.ts';
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
	type Row = StopPrediction & RecordTableRow;
	const readings = $derived(
		rows.map((row): Row => {
			const name = row.line ? display.lineName(row.line) : null;
			return {
				...row,
				id: row.key,
				label: name?.name ?? (row.line ? '' : t('Not published', 'Non publié')),
				plate: row.line ? { code: name?.number ?? row.line } : undefined,
				href: row.line
					? carryFrameState(
							localizeHref('/lines/' + encodeURIComponent(row.line), locale, city),
							url,
						)
					: undefined,
			};
		}),
	);
	let container = $state<HTMLDivElement>();
	let needsScroll = $state(false);
	$effect(() => {
		const element = container;
		if (!element) return;
		const root = element.ownerDocument.documentElement;
		const measure = () => {
			const rem = Number.parseFloat(getComputedStyle(root).fontSize);
			// Below this width in text units, the two lead cells need a scrollable table.
			needsScroll = element.clientWidth < 12 * rem;
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	});
	const columns = $derived<DataTableColumn<Row>[]>([
		{ key: 'expected', header: t('Expected', 'Prévu'), cell: expected },
	]);
</script>

{#snippet expected(row: Row)}
	{@const time = predictedIn(row.predictedAt, now, locale)}
	{@const href =
		row.line && row.start
			? departureHref(url, locale, city, row.line, row.direction, row.start, 'live', row.trip)
			: null}
	{#if href}
		<a class="inline-flex min-h-11 min-w-11 items-center text-primary underline tabular-nums" {href}
			>{time}</a
		>
	{:else}<span class="tabular-nums">{time}</span>{/if}
{/snippet}

{#snippet status(row: StopPrediction)}
	{@const band = classifyDelay(row.delay)}
	<StatusMark
		class="font-sans"
		status={band}
		label={liveDelayLabels(locale)[band]}
		detail={row.delay === null
			? undefined
			: delayReading(row.delay, locale).toLocaleLowerCase(locale)}
	/>
{/snippet}

<div class="min-w-0" bind:this={container}>
	<RecordDataTable
		{locale}
		title={caption}
		rowHeader={t('Line', 'Ligne')}
		value="expected"
		{columns}
		rows={readings}
		scrollMinWidth={needsScroll ? '25rem' : undefined}
	>
		{#snippet rowHeading(row)}
			<RecordTableName {row} plates columnCount={2} inlinePlate>
				{#snippet detailContent()}
					<span
						>{t('Toward', 'Vers')}
						{row.toward
							? display.readName(row.toward, locale)
							: t('Unavailable', 'Indisponible')}</span
					>
					<span aria-hidden="true"> · </span>
					<span class="tabular-nums"
						>{t('Scheduled', 'Horaire')}
						{row.scheduledAt === null
							? t('Unavailable', 'Indisponible')
							: clockTime(new Date(row.scheduledAt), locale, timeZone)}</span
					>
					<span aria-hidden="true"> · </span>
					{@render status(row)}
				{/snippet}
			</RecordTableName>
		{/snippet}
	</RecordDataTable>
</div>
