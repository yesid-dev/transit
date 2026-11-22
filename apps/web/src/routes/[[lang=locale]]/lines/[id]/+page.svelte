<script lang="ts">
	import { page } from '$app/state';
	import { getLocale } from '#lib/i18n/index.ts';
	import LineRecord from '#lib/features/lines/LineRecord.svelte';
	import LineViewNav from '#lib/features/lines/LineViewNav.svelte';
	import RouteDetail from '#lib/features/lines/RouteDetail.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const locale = getLocale();
	const url = $derived(new URL(page.shallow?.url.href ?? page.url.href));
</script>

{#if data.record && data.metadata}
	<LineRecord name={data.seed.name} {locale} {url} record={data.record} metadata={data.metadata} />
{:else}
	{#if data.frameLive}<LineViewNav {url} {locale} view="live" />{/if}
	<RouteDetail
		id={data.seed.id}
		seed={data.seed}
		frameLive={data.frameLive}
		routeSeed={data.routeSeed ?? undefined}
		reliabilitySeed={data.reliabilitySeed ?? undefined}
		lineHistorySeed={data.lineHistorySeed ?? undefined}
		initialClusters={data.initialClusters}
		initialImportFailed={data.initialImportFailed}
		preparedArticleTime={data.preparedArticleTime}
	/>
{/if}
