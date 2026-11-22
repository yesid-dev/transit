<script lang="ts">
	import VehiclePage from '#lib/features/vehicles/VehiclePage.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<VehiclePage {data} />
