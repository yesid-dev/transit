<script lang="ts">
	import type { StopEta } from '#lib/v1/schemas/index.ts';
	import { getLocalizeHref, type Locale } from '#lib/i18n/index.ts';
	import { routeFor } from '#lib/nav/index.ts';
	import { stopDisplayName } from '#lib/site/transitDisplay.ts';
	import { stopNameFallback, type AbsenceReasonKey } from '#lib/site/absence.ts';
	import { formatLocalClock } from '#lib/utils/time.ts';
	import { delayMeasurement } from '#lib/site/delayPresentation.ts';
	import { DataTable, type DataTableColumn } from '@yesid/ui/table';
	import { Button } from '@yesid/ui/button';
	import { MaybeValue } from '#lib/components/edge/index.ts';
	import { reportedOffset } from './tripReportCsv';
	import { tripCopy } from './trips.copy';
	let {
		predictions,
		stopNames,
		locale,
		provider,
		timeZone,
		absenceReason,
	}: {
		predictions: readonly StopEta[];
		stopNames: Readonly<Record<string, string>>;
		locale: Locale;
		provider: string;
		timeZone: string;
		absenceReason: AbsenceReasonKey;
	} = $props();
	const t = $derived(tripCopy[locale]);
	const localizeHref = getLocalizeHref();
	const uid = $props.id();
	let expanded = $state(false);
	const rows = $derived(expanded ? predictions : predictions.slice(0, 6));
	const nameFor = (id: string) =>
		Object.hasOwn(stopNames, id) ? stopDisplayName(stopNames[id]) : stopNameFallback(id, locale);
</script>

{#snippet stopCell(prediction: StopEta)}
	<a
		class="trip-stop-link"
		href={localizeHref(routeFor({ kind: 'stop', id: prediction.stop }), locale, provider)}
	>
		<span class="sr-only">{t.viewStop} </span><span
			class="trip-stop-name"
			title={nameFor(prediction.stop)}>{nameFor(prediction.stop)}</span
		>
	</a>
{/snippet}
{#snippet timeCell(prediction: StopEta)}
	<time class="trip-stop-eta" datetime={prediction.eta_utc}
		>{formatLocalClock(new Date(prediction.eta_utc), locale, timeZone)}</time
	>
{/snippet}
{#snippet offsetCell(prediction: StopEta)}
	<span class="trip-stop-offset"
		><MaybeValue
			value={delayMeasurement(reportedOffset(prediction.delay_min))}
			reason={absenceReason}
			{locale}
			variant="row"
		/></span
	>
{/snippet}

<div id={uid}>
	<DataTable
		{rows}
		columns={[
			{ key: 'stop', header: t.columns.stop, rowHeader: true, cell: stopCell },
			{ key: 'time', header: t.columns.time, cell: timeCell },
			{ key: 'offset', header: t.columns.offset, cell: offsetCell },
		] satisfies readonly DataTableColumn<StopEta>[]}
		key={(prediction, index) => `${prediction.stop}-${index}`}
		caption={t.reportedPredictions}
		responsive={{ mode: 'stack', at: 'tablet' }}
		frame="none"
		headerBand="none"
		tableClass="trip-predictions"
		class="trip-prediction-table"
	/>
</div>
{#if predictions.length > 6}
	<Button
		variant="outline"
		class="min-h-11"
		aria-expanded={expanded}
		aria-controls={uid}
		onclick={() => (expanded = !expanded)}
		>{expanded ? t.showFewer : t.showAll(predictions.length)}</Button
	>
{/if}

<style>
	.trip-stop-link {
		display: flex;
		min-height: 2.75rem;
		align-items: center;
		color: var(--foreground);
		text-underline-offset: 0.2em;
	}
	.trip-stop-name {
		font-family: var(--font-body);
		overflow-wrap: normal;
		word-break: normal;
	}
	.trip-stop-eta,
	.trip-stop-offset {
		font-variant-numeric: tabular-nums;
		overflow-wrap: normal;
		word-break: normal;
	}
	:global(.trip-prediction-table .trip-predictions :is(th, td)) {
		overflow-wrap: normal;
		word-break: normal;
		white-space: normal;
	}
	.trip-stop-link:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}
</style>
