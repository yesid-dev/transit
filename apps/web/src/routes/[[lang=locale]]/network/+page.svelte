<script lang="ts">
	import { afterNavigate, goto } from '$app/navigation';
	import { SvelteURL } from 'svelte/reactivity';
	import { page } from '$app/state';
	import { Surface } from '@yesid/ui/layout';
	import { getLocale } from '#lib/i18n/index.ts';
	import { localizeHref } from '#lib/i18n/routing.ts';
	import { carryFrameState } from '#lib/site/frameState.ts';
	import NetworkRecord from '#lib/features/network/NetworkRecord.svelte';
	import NetworkLive from '#lib/features/network/NetworkLive.svelte';
	import { networkMeasures } from '#lib/features/network/networkMeasures.ts';
	import { providerDisplayNames } from '#lib/site/providerDisplay.ts';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const locale = getLocale();
	const url = $derived(new URL(page.url.href));
	const names = $derived(providerDisplayNames(data.provider, locale, data.providerId));
	const healthLink = $derived(
		carryFrameState(localizeHref('/status', locale, data.providerId), url),
	);

	// Links copied before the feed diagnostics moved still open the same section.
	afterNavigate(({ to }) => {
		if (
			!to?.url.pathname.endsWith('/network') ||
			!Object.hasOwn(networkMeasures, to.url.hash.slice(1))
		)
			return;
		const destination = new SvelteURL(to.url);
		destination.pathname = destination.pathname.replace(/\/network$/, '/status');
		destination.searchParams.set('frameMode', 'live');
		void goto(destination, { replaceState: true });
	});
</script>

<Surface>
	{#if data.view === 'record'}
		<NetworkRecord
			record={data.networkRecord}
			subject={names.operatorCity}
			operator={names.short}
			{locale}
			{url}
		/>
	{:else}
		<NetworkLive
			capture={data.capture}
			captureClock={data.captureClock}
			city={data.provider?.inputs.vehicle_positions ? data.providerId : null}
			subject={names.operatorCity}
			operator={names.short}
			{healthLink}
			{locale}
			{url}
			schedule={data.schedule}
		/>
	{/if}
</Surface>
