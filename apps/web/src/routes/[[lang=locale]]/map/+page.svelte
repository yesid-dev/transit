<script lang="ts">
	import { page } from '$app/state';
	import MapProgressive from '#lib/features/map/MapProgressive.svelte';
	import { mapLayerFor } from '#lib/site/mapFrame.ts';
	const record = $derived(mapLayerFor((page.shallow?.url ?? page.url).searchParams) !== 'live');
</script>

<MapProgressive {record} />
