<script lang="ts">
	import { page } from '$app/state';
	import { getLocale } from '#lib/i18n/index.ts';
	import NetworkRecord from '#lib/features/network/NetworkRecord.svelte';
	import { NetworkSurface } from '#lib/features/network/reliability/index.ts';
	import { providerDisplayNames } from '#lib/site/providerDisplay.ts';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const locale = getLocale();
	const url = $derived(new URL(page.url.href));
	const subject = $derived(providerDisplayNames(data.provider, locale, data.providerId).full);
</script>

{#if data.view === 'record'}
	<NetworkRecord record={data.networkRecord} {subject} {locale} {url} />
{:else}
	<NetworkSurface
		liveOnly
		historicAvailabilitySeed={data.historicAvailabilitySeed ?? {
			key: 'historic-availability',
			data: null,
		}}
		networkSeed={data.networkSeed ?? undefined}
		trendSeed={data.trendSeed ?? undefined}
		provenanceSeed={data.provenanceSeed ?? undefined}
	/>
{/if}
