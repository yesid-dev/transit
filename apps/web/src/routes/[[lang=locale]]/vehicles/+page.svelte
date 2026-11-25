<script lang="ts">
	import VehicleFleet from '#lib/features/vehicles/VehicleFleet.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

{#key data.city + '|' + data.mode}
	<VehicleFleet {data} />
{/key}
