<script lang="ts">
	import { page } from '$app/state';
	import { getLocale } from '#lib/i18n/index.ts';
	import LinesIndex from '#lib/features/lines/LinesIndex.svelte';
	import LinesRecordFinder from '#lib/features/lines/LinesRecordFinder.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const locale = getLocale();
</script>

{#if data.finderRecord}
	<LinesRecordFinder
		{locale}
		url={new URL(page.url.href)}
		record={data.finderRecord}
		routes={data.routesIndex?.routes ?? []}
	/>
{:else}
	<LinesIndex />
{/if}
