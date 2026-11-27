<script lang="ts">
	import { recoverReadings } from '#lib/features/record/recordRecovery.svelte.ts';
	import VehiclePage from '#lib/features/vehicles/VehiclePage.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const readings = recoverReadings(
		() => data,
		({ period, id, city }) =>
			period && id ? { screen: 'vehicle', from: period.from, to: period.to, id, city } : null,
	);
	const record = $derived(readings() ?? data);
</script>

<VehiclePage data={record} />
