<script lang="ts">
	import { page } from '$app/state';
	import MapProgressive from '#lib/features/map/MapProgressive.svelte';
	import { mapLayerFor } from '#lib/site/mapFrame.ts';
	import { onMount } from 'svelte';
	import type { PageProps } from './$types';

	let { data }: { data?: PageProps['data'] } = $props();
	let mounted = $state(false);
	onMount(() => {
		mounted = true;
	});
	const record = $derived(
		mounted
			? mapLayerFor((page.shallow?.url ?? page.url).searchParams) !== 'live'
			: (data?.record ?? false),
	);
</script>

<MapProgressive {record} />
