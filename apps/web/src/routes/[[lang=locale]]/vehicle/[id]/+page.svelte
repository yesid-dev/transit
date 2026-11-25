<script lang="ts">
	import { recoverRecord } from '#lib/features/record/recordRecovery.svelte.ts';
	import VehiclePage from '#lib/features/vehicles/VehiclePage.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const readings = recoverRecord(
		() => data,
		({ period, id, city }) => (period && id ? { ...period, id, city, kind: 'vehicle' } : null),
	);
	const record = $derived(readings() ?? data);
</script>

<VehiclePage data={record} />
