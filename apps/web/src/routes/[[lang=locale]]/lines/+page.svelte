<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { getLocale } from '#lib/i18n/index.ts';
	import LinesRecordFinder from '#lib/features/lines/LinesRecordFinder.svelte';
	import { lineSort, lineSortKeys } from '#lib/features/lines/linesRecord.ts';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const locale = getLocale();
	const url = $derived(new URL(page.shallow?.url.href ?? page.url.href));
	const sort = $derived(page.shallow ? lineSort(url.searchParams) : data.sort);

	function onSort(key: string) {
		const choice = lineSortKeys.find((option) => option === key);
		if (!choice) return;
		const next = new URL(url);
		next.searchParams.set('sort', choice);
		next.searchParams.set(
			'direction',
			sort.key === choice && sort.direction === 'asc' ? 'desc' : 'asc',
		);
		void goto(next, { shallow: true, state: page.state });
	}
</script>

{#if data.finderRecord}
	<LinesRecordFinder
		{locale}
		{url}
		{sort}
		{onSort}
		record={data.finderRecord}
		routes={data.schedule?.routes ?? []}
		directions={data.schedule?.route_directions}
		provider={data.provider}
	/>
{/if}
