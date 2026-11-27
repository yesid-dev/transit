<script lang="ts">
	import { page } from '$app/state';
	import { Surface } from '@yesid/ui/layout';
	import { getLocale } from '#lib/i18n/index.ts';
	import RecordDataHealth from '#lib/features/record/RecordDataHealth.svelte';
	import DataHealthLive from '#lib/features/health/DataHealthLive.svelte';
	import { providerDisplayNames } from '#lib/site/providerDisplay.ts';
	import { recoverReadings } from '#lib/features/record/recordRecovery.svelte.ts';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const locale = getLocale();
	const url = $derived(new URL(page.url.href));
	const names = $derived(providerDisplayNames(data.provider, locale, data.providerId));
	const readings = recoverReadings(
		() => (data.view === 'record' ? data.record : null),
		({ period: { from, to }, city }) => ({ screen: 'status', from, to, city }),
	);
</script>

<Surface>
	{#if data.view === 'record'}
		<RecordDataHealth
			{locale}
			{url}
			subject={names.operatorCity}
			operator={names.short}
			alerts={data.alerts}
			operatorOf={data.provider?.download_licence?.source?.fr}
			record={readings() ?? null}
		/>
	{:else}
		<DataHealthLive
			alerts={data.alerts}
			operatorOf={data.provider?.download_licence?.source?.fr}
			{locale}
			subject={names.operatorCity}
			operator={names.short}
			city={data.provider ? data.providerId : null}
			capture={data.capture}
		/>
	{/if}
</Surface>
