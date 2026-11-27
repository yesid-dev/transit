<script module lang="ts">
	import { browser } from '$app/env';
	import { mapStageImports } from '#lib/components/map/mapStageImports.ts';

	// Start fetching the map as soon as the route module arrives. The poster still owns
	// rendering and can catch a failed import through its existing retry flow.
	let prefetchedHero = browser ? import('#lib/features/map/MapHero.svelte') : undefined;
	void prefetchedHero?.catch(() => {});
	if (browser)
		void Promise.all([
			mapStageImports.maplibre(),
			mapStageImports.css(),
			mapStageImports.pmtiles(),
		]).catch(() => {});

	function importHero() {
		const prefetched = prefetchedHero;
		prefetchedHero = undefined;
		return prefetched ?? import('#lib/features/map/MapHero.svelte');
	}
</script>

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

<MapProgressive {record} {importHero} />
