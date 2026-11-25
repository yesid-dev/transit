<script lang="ts">
	import { tripReportCsv } from './tripReportCsv';
	import { tripCopy } from './trips.copy';
	import TripPredictionTable from './TripPredictionTable.svelte';
	import RecordCard from '#lib/features/record/RecordCard.svelte';
	import type { Locale } from '#lib/i18n/index.ts';
	import type { TripsFile } from '#lib/v1/schemas/index.ts';
	import type { AbsenceReasonKey } from '#lib/site/absence.ts';

	let {
		id,
		report,
		locale,
		provider,
		timeZone,
		absenceReason,
		stopNames,
		current,
		inSheet = false,
	}: {
		id: string;
		report: TripsFile;
		locale: Locale;
		provider: string;
		timeZone: string;
		absenceReason: AbsenceReasonKey;
		stopNames: Readonly<Record<string, string>>;
		current: boolean;
		inSheet?: boolean;
	} = $props();
	const copy = $derived(tripCopy[locale]);
	const trip = $derived(report.trips[id]);
	const predictions = $derived(trip?.stops ?? []);
	const csv = $derived(
		trip
			? 'data:text/csv;charset=utf-8,' +
					encodeURIComponent(
						tripReportCsv({
							provider,
							tripId: id,
							trip,
							report,
							timeZone,
							stopNames,
						}),
					)
			: null,
	);
</script>

<RecordCard
	title={copy.reportedPredictions}
	interactive={!!csv}
	edge={inSheet ? 'neutral' : undefined}
>
	<div class="grid min-w-0 gap-3">
		<p>{copy.observedCaveat}</p>
		{#if !current}<p>{copy.retainedReport}</p>{/if}
		{#if predictions.length}
			<p>{copy.predictionCaveat}</p>
			{#key id}
				<TripPredictionTable
					{predictions}
					{stopNames}
					{locale}
					{provider}
					{timeZone}
					{absenceReason}
				/>
			{/key}
		{:else}
			<p>{copy.noPredictions}</p>
		{/if}
	</div>
	{#snippet footer()}
		{#if csv}
			<a
				class="inline-flex min-h-11 items-center text-primary underline"
				href={csv}
				download={'trip-' + encodeURIComponent(id) + '-all-predictions.csv'}>{copy.download}</a
			>
		{/if}
	{/snippet}
</RecordCard>
