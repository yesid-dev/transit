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
	import type { PageData } from './$types';

	let { data }: { data: Pick<PageData, 'provider' | 'v1'> & Partial<Pick<PageData, 'record'>> } =
		$props();
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
	const copy = $derived({
		...homeCopy[locale],
		cadence: homeCadence(locale, data.v1?.manifest.files.live.ttl_s),
		headline: homeCopy[locale].headline.replace('{city}', city),
		auditBody: homeAuditBody(locale, city),
		auditMore: homeCopy[locale].auditMore.replace('{operator}', operator),
		audience: homeCopy[locale].audience.replace('{operator}', operator),
	});
</script>

<Surface>
	{#if data.record}
		<OverviewRecord {locale} {city} href={page.url.href} record={data.record} />
	{:else}
		<HomeExplore {locale} {copy} alertsAvailable={providerHasAlerts(data.provider)}>
			{#snippet pulse()}
				<HomePulse {locale} manifest={data.v1?.manifest ?? null} />
			{/snippet}
		</HomeExplore>
		<HomeInvite {locale} />
	{/if}
</Surface>
