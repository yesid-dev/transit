<script lang="ts">
	import { page } from '$app/state';
	import { Surface } from '@yesid/ui/layout';
	import { getLocale } from '#lib/i18n/index.ts';
	import NetworkRecord from '#lib/features/network/NetworkRecord.svelte';
	import { NetworkSurface } from '#lib/features/network/reliability/index.ts';
	import { frameHref, frameToday, parseFrameState } from '#lib/site/frameState.ts';
	import { providerDisplayNames } from '#lib/site/providerDisplay.ts';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const locale = getLocale();
	const url = $derived(new URL(page.url.href));
	const recordHref = $derived.by(() => {
		const link = new URL(url.pathname, url);
		link.searchParams.set('provider', data.providerId);
		const { period } = parseFrameState(url.searchParams, frameToday());
		return frameHref(link, { mode: 'record', period });
	});
	const subject = $derived(providerDisplayNames(data.provider, locale, data.providerId).full);
</script>

{#if data.view === 'record'}
	<NetworkRecord record={data.networkRecord} {subject} {locale} {url} />
{:else}
	{#if url.searchParams.get('frameMode') === 'live'}
		<Surface>
			<a href={recordHref}>{locale === 'fr' ? 'Voir le bilan' : 'See the record'}</a>
		</Surface>
	{/if}
	<NetworkSurface
		historicAvailabilitySeed={data.historicAvailabilitySeed ?? {
			key: 'historic-availability',
			data: null,
		}}
		networkSeed={data.networkSeed ?? undefined}
		trendSeed={data.trendSeed ?? undefined}
		provenanceSeed={data.provenanceSeed ?? undefined}
	/>
{/if}
