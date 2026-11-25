<script lang="ts">
	import { page } from '$app/state';
	import MapHero from '#lib/features/map/__fixtures__/MapHeroRailHarness.svelte';

	const isMap = $derived(/^\/(?:fr\/)?map\/?$/u.test(page.url.pathname));
</script>

<main id="main-flow" class:overflow-hidden={isMap} class:h-dvh={isMap} class:min-h-dvh={!isMap}>
	{#if isMap}
		<MapHero />
	{:else}
		<h1>Lines</h1>
	{/if}
</main>
