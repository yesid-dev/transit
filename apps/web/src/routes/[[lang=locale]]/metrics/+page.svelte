<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { getLocale } from '#lib/i18n/index.ts';
	import MethodCatalog from '#lib/features/record/MethodCatalog.svelte';
	import { METRIC_SUMMARIES } from '#lib/metrics.ts';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const locale = getLocale();
	const url = $derived(new URL(page.url.href));

	const archivedAnchors = new Set([
		...Object.values(METRIC_SUMMARIES).map(({ anchor }) => anchor),
		'metrics-provenance',
		'confidence-intervals',
		'history-depth',
		'live-positions',
		'structural-gaps',
	]);
	$effect(() => {
		if (!archivedAnchors.has(url.hash.slice(1))) return;
		void goto(`${url.pathname}/archive${url.search}${url.hash}`, { replaceState: true });
	});
</script>

<MethodCatalog
	{locale}
	{url}
	city={data.providerId}
	period={data.period}
	catalog={data.catalog}
	cleaningVersion={data.cleaningVersion}
/>
