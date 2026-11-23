<script lang="ts">
	import { page } from '$app/state';
	import { getLocale } from '#lib/i18n/index.ts';
	import StopEngineRecord from '#lib/features/stops/StopEngineRecord.svelte';
	import StopDetail from '#lib/features/stops/StopDetail.svelte';
	import StopViewNav from '#lib/features/stops/StopViewNav.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const locale = getLocale();
	const url = $derived(new URL(page.shallow?.url.href ?? page.url.href));
</script>

{#if data.record}
	<StopEngineRecord stop={data.seed} code={data.stopCode} {locale} {url} record={data.record} />
{:else if data.frameLive && data.v1}
	{#if data.frameLive}<StopViewNav {locale} {url} view="live" />{/if}
	<StopDetail
		id={data.seed.id}
		seed={data.seed}
		stopSeed={data.stopSeed ?? undefined}
		frameLive={data.frameLive}
	/>
{/if}
