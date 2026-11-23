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

{#if data.record}
	<LineRecord
		name={data.seed.name}
		code={data.code}
		scheduleOnly={data.scheduleOnly}
		{locale}
		{url}
		record={data.record}
		headsigns={data.directionHeadsigns}
		stopNames={data.stopNames}
	/>
{:else if data.frameLive && data.v1}
	{#if data.frameLive}<LineViewNav {url} {locale} view="live" />{/if}
	<RouteDetail id={data.seed.id} seed={data.seed} routeSeed={data.routeSeed ?? undefined} />
{/if}
