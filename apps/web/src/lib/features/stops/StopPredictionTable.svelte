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
	const columns = $derived<DataTableColumn<StopPrediction>[]>([
		{ key: 'line', header: t('Line', 'Ligne'), width: '30%', rowHeader: true, cell: line },
		{ key: 'toward', header: t('Toward', 'Vers'), cell: toward },
		{ key: 'scheduled', header: t('Scheduled', 'Horaire'), cell: scheduled },
		{ key: 'expected', header: t('Expected', 'Prévu'), cell: expected },
		{ key: 'status', header: t('Status', 'État'), cell: status },
	]);
</script>

{#snippet line(row: StopPrediction)}
	{#if row.line}
		<StopLineTableLink
			id={row.line}
			wrap
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
	{row.toward ? display.readName(row.toward, locale) : t('Unavailable', 'Indisponible')}
{/snippet}

{#snippet scheduled(row: StopPrediction)}
	<span class="tabular-nums">
		{row.scheduledAt === null
			? t('Unavailable', 'Indisponible')
			: clockTime(new Date(row.scheduledAt), locale, timeZone)}
	</span>
{/snippet}

{#snippet expected(row: StopPrediction)}
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
	<DataTable
		{caption}
		{columns}
		{rows}
		key={(row) => row.key}
		responsive={needsScroll
			? { mode: 'scroll', minWidth: '36rem' }
			: { mode: 'rows', primary: 'line', value: 'expected' }}
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
</div>
