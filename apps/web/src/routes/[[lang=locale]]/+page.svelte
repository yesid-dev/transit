<script lang="ts">
	import { page } from '$app/state';
	import { providerHasAlerts } from '#lib/v1/providers.ts';
	import { getLocale, type Locale } from '#lib/i18n/index.ts';
	import { Surface } from '@yesid/ui/layout';
	import HomeExplore from '#lib/features/home/HomeExplore.svelte';
	import HomeInvite from '#lib/features/home/HomeInvite.svelte';
	import HomePulse from '#lib/features/home/HomePulse.svelte';
	import OverviewRecord from '#lib/features/home/OverviewRecord.svelte';
	import { homeAuditBody, homeCadence, homeCopy } from '#lib/features/home/home.copy.ts';
	import { providerDisplayNames, publishedNetwork } from '#lib/site/providerDisplay.ts';
	import type { PageData } from './$types';

	let {
		data,
	}: {
		data: Pick<PageData, 'provider' | 'providerId' | 'v1'> &
			Partial<Pick<PageData, 'record' | 'liveRecord'>>;
	} = $props();
	const locale: Locale = getLocale();
	const city = $derived(
		data.provider?.labels[locale].city ??
			data.v1?.manifest.city ??
			data.v1?.manifest.provider ??
			'',
	);
	const operator = $derived(
		data.provider?.labels[locale].operator ?? data.v1?.manifest.display_name ?? city,
	);
	const networkLabel = $derived(
		providerDisplayNames(data.provider ?? publishedNetwork(data.providerId), locale, '').full,
	);
	const copy = $derived({
		...homeCopy[locale],
		cadence: homeCadence(locale, data.v1?.manifest.files.live.ttl_s),
		headline: homeCopy[locale].headline.replace('{city}', city),
		auditBody: homeAuditBody(locale, networkLabel),
		audience: homeCopy[locale].audience.replace('{operator}', operator),
	});
</script>

<Surface>
	{#if data.record}
		<OverviewRecord
			{locale}
			{city}
			{operator}
			provider={data.providerId}
			href={page.url.href}
			alertsAvailable={providerHasAlerts(data.provider)}
			record={data.record}
		/>
	{:else}
		<HomeExplore {locale} {copy} alertsAvailable={providerHasAlerts(data.provider)}>
			{#snippet pulse()}
				<HomePulse {locale} manifest={data.v1?.manifest ?? null} record={data.liveRecord ?? null} />
			{/snippet}
		</HomeExplore>
		<HomeInvite {locale} />
	{/if}
</Surface>
