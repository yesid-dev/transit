<script lang="ts">
	import { page } from '$app/state';
	import { getV1Runtime } from '#lib/v1/runtime.ts';
	import StopsFinder from './StopsFinder.svelte';
	import type { StopsRecord } from '#lib/server/finderRecord.ts';

	import type { ScheduleEdition } from '#lib/search/searchIndex.ts';
	import type { PublicCity } from '#lib/v1/schemas/providers.ts';

	let {
		record = null,
		schedule = null,
		provider = null,
	}: {
		record?: StopsRecord | null;
		schedule?: ScheduleEdition | null;
		provider?: PublicCity | null;
	} = $props();

	/**
	 * The finder's owner: its state lives in the URL, and its records belong to one publication. A
	 * provider change is a navigation and a data refresh bumps the epoch, so both remount the finder
	 * instead of leaving another provider's or an older file's figures on screen. The URL keeps the
	 * view across the remount.
	 */
	const runtime = getV1Runtime();
	const selectedId = $derived(page.url.searchParams.get('provider') ?? '');
</script>

{#key `${selectedId}|${runtime.refresh.epoch}`}
	<StopsFinder {record} {schedule} {provider} />
{/key}
