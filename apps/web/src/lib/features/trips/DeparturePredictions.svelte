<script lang="ts">
	import { untrack } from 'svelte';
	import type { Locale } from '#lib/i18n/index.ts';
	import { liveAbsenceReason } from '#lib/site/absence.ts';
	import { getV1Context } from '#lib/v1/boot.ts';
	import { createLiveResource } from '#lib/v1/live/resource.ts';
	import LiveTripPredictions from './LiveTripPredictions.svelte';
	import RecordCard from '#lib/features/record/RecordCard.svelte';
	import RecordPending from '#lib/features/record/RecordPending.svelte';
	import { tripCopy } from './trips.copy';

	let { id, locale, stopNames }: { id: string; locale: Locale; stopNames: Record<string, string> } =
		$props();
	const { manifest, provider } = getV1Context();
	const { live, resource } = createLiveResource(
		manifest,
		'trips',
		untrack(() => ({ kind: 'trip', id })),
	);
</script>

{#if resource.data}
	<LiveTripPredictions
		{id}
		report={resource.data}
		{locale}
		provider={manifest.provider}
		timeZone={provider?.timezone ?? manifest.tz ?? 'UTC'}
		{stopNames}
		current={live.familyStates.trips.health.state === 'live'}
		absenceReason={liveAbsenceReason('trip-delay', { familyStates: live.familyStates })}
	/>
{:else}
	<RecordCard title={tripCopy[locale].reportedPredictions} reserve={{ shape: 'table', rows: 6 }}>
		{#if !resource.settled}
			<RecordPending {locale} shape={{ shape: 'table', rows: 6 }} />
		{:else}
			<p>{tripCopy[locale].noPredictions}</p>
		{/if}
	</RecordCard>
{/if}
