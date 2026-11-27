<script lang="ts">
	import { page } from '$app/state';
	import { recoverReadings } from '#lib/features/record/recordRecovery.svelte.ts';
	import VehicleFleet from '#lib/features/vehicles/VehicleFleet.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const readings = recoverReadings(
		() => data,
		({ period, city }) =>
			period
				? {
						screen: 'vehicles',
						from: period.from,
						to: period.to,
						city,
						lang: data.lang,
						// The list's own choices (reporting, rows shown) shape its answer.
						page: page.url.searchParams.toString(),
					}
				: null,
	);
	const record = $derived(readings() ?? data);
</script>

{#key data.city + '|' + data.mode}
	<VehicleFleet data={record} />
{/key}
