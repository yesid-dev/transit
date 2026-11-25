<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Surface } from '@yesid/ui/layout';
	import { getLocale } from '#lib/i18n/index.ts';
	import LinesRecordFinder from '#lib/features/lines/LinesRecordFinder.svelte';
	import {
		firstLineSort,
		lineSort,
		lineSortKeys,
		type LineSort,
	} from '#lib/features/lines/linesRecord.ts';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const locale = getLocale();
	const url = $derived(new URL(page.shallow?.url.href ?? page.url.href));
	const sort = $derived(page.shallow ? lineSort(url.searchParams) : data.sort);

	function setSort(key: string, toggle: boolean) {
		const choice = lineSortKeys.find((option) => option === key);
		if (!choice) return;
		const target: LineSort =
			toggle && sort.key === choice
				? { key: choice, direction: sort.direction === 'asc' ? 'desc' : 'asc' }
				: firstLineSort(choice);
		if (sort.key === target.key && sort.direction === target.direction) return;
		const next = new URL(url);
		next.searchParams.set('sort', target.key);
		next.searchParams.set('direction', target.direction);
		void goto(next, { shallow: true, state: page.state });
	}
</script>

{#if data.finderRecord}
	<Surface>
		<LinesRecordFinder
			{locale}
			{url}
			{sort}
			{setSort}
			record={data.finderRecord}
			routes={data.schedule?.routes ?? []}
			directions={data.schedule?.route_directions}
			provider={data.provider}
		/>
	</Surface>
{/if}
