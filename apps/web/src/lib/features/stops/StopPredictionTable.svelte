<script lang="ts">
	import { StatusMark } from '@yesid/ui/brand';
	import type { DataTableColumn } from '@yesid/ui/table';
	import { localizeHref, type Locale } from '#lib/i18n/index.ts';
	import { departureHref } from '#lib/features/record/departureIdentity.ts';
	import RecordDataTable, { type RecordTableRow } from '../record/RecordDataTable.svelte';
	import RecordTableName from '../record/RecordTableName.svelte';
	import { carryFrameState } from '#lib/site/frameState.ts';
	import {
		clockTime,
		expectedReading,
		liveDelayLabels,
		liveStatusWords,
	} from '#lib/site/presenter.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { classifyDelay } from '#lib/v1/live/statusBands.ts';
	import { choose } from '../record/recordText.ts';
	import { riderToward, type StopPrediction } from './stopLiveReadings.ts';
	import type { LinePattern } from '#lib/site/linePatterns.ts';

	let {
		rows,
		caption,
		locale,
		city,
		url,
		timeZone,
		now,
		patterns,
		pageSize,
	}: {
		rows: StopPrediction[];
		caption: string;
		locale: Locale;
		city: string;
		url: URL;
		timeZone: string;
		now: number;
		patterns?: Readonly<Record<string, LinePattern>>;
		/** Rows shown before Show more. */
		pageSize?: number;
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
	const hasPlates = $derived(readings.some(({ plate }) => plate !== undefined));
	let container = $state<HTMLDivElement>();
	let needsScroll = $state(false);
	$effect(() => {
		const element = container;
		if (!element) return;
		const root = element.ownerDocument.documentElement;
		const measure = () => {
			const rem = Number.parseFloat(getComputedStyle(root).fontSize);
			// Below this width in text units (e.g. 200% text on phone), stacked labels run out of room.
			needsScroll = element.clientWidth < 12 * rem;
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	});
	const columns = $derived<DataTableColumn<Row>[]>([
		// A feed that gives no trip a direction gets one sentence under the table, not a column of
		// "Unavailable".
		...(rows.some((row) => row.toward)
			? [{ key: 'toward', header: t('Toward', 'Vers'), cell: toward }]
			: []),
		{ key: 'scheduled', header: t('Scheduled', 'Horaire'), cell: scheduled },
		{ key: 'expected', header: t('Expected', 'Attendu'), cell: expected },
		{ key: 'status', header: t('Status', 'État'), cell: statusCell },
	]);
</script>

{#snippet toward(row: Row)}
	<span class="prediction-cell wrap-normal"
		>{riderToward(display, row, locale, 'cell', patterns) ?? t('Unavailable', 'Indisponible')}</span
	>
{/snippet}

{#snippet scheduled(row: Row)}
	<span class="prediction-cell tabular-nums wrap-normal">
		{row.scheduledAt === null
			? t('Unavailable', 'Indisponible')
			: clockTime(new Date(row.scheduledAt), locale, timeZone)}
	</span>
{/snippet}

{#snippet expected(row: Row)}
	{@const time = expectedReading(row.predictedAt, now, locale, timeZone)}
	{@const href =
		row.line && row.start
			? departureHref(url, locale, city, row.line, row.direction, row.start, 'live', row.trip)
			: null}
	{#if href}
		<a
			class="inline-flex min-h-11 min-w-11 items-center text-primary underline tabular-nums wrap-normal"
			{href}>{time}</a
		>
	{:else}<span class="prediction-cell tabular-nums wrap-normal">{time}</span>{/if}
{/snippet}

{#snippet status(row: StopPrediction)}
	{@const band = classifyDelay(row.delay)}
	<StatusMark
		class="font-sans"
		status={band}
		{...liveStatusWords(band, liveDelayLabels(locale)[band], row.delay, locale)}
	/>
{/snippet}

{#snippet statusCell(row: Row)}
	<span class="prediction-cell">{@render status(row)}</span>
{/snippet}

<div class="stop-predictions min-w-0" bind:this={container}>
	<RecordDataTable
		{locale}
		title={caption}
		rowHeader={t('Line', 'Ligne')}
		{columns}
		rows={readings}
		stackAt="compact"
		scrollMinWidth={needsScroll ? '36rem' : undefined}
		pageSize={pageSize !== undefined && rows.length > pageSize ? pageSize : undefined}
	>
		{#snippet rowHeading(row)}
			<RecordTableName {row} plates={hasPlates} columnCount={columns.length + 1} inlinePlate />
		{/snippet}
	</RecordDataTable>
</div>

<style>
	.prediction-cell {
		display: inline-flex;
		min-block-size: var(--size-tap-min);
		align-items: center;
	}

	@media (max-width: 28rem) {
		.stop-predictions :global(.data-table-frame[data-stack-at='compact'] .prediction-cell) {
			min-block-size: 0;
		}
		.stop-predictions
			:global(.data-table-frame[data-stack-at='compact'] .data-table tbody :is(th, td)) {
			align-items: center;
		}
		.stop-predictions
			:global(
				.data-table-frame[data-stack-at='compact']
					.data-table
					tbody
					:is(th, td[data-column='expected']):has(a)
			) {
			padding-block: 0;
		}
	}
</style>
