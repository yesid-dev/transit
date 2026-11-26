<script lang="ts">
	import { page } from '$app/state';
	import { Surface } from '@yesid/ui/layout';
	import { providerHasAlerts } from '#lib/v1/providers.ts';
	import Overview from '#lib/features/home/Overview.svelte';
	import { overviewCopy } from '#lib/features/home/overviewRecord.copy.ts';
	import ScreenTitle from '#lib/features/record/ScreenTitle.svelte';
	import StateMark from '#lib/features/record/StateMark.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const locale = $derived(data.lang);
	const city = $derived(data.provider?.labels[locale].city ?? '');
	const operator = $derived(data.provider?.labels[locale].operator ?? city);
</script>

<Surface>
	{#if data.record}
		<Overview
			{locale}
			{city}
			{operator}
			mode={data.mode}
			provider={data.providerId}
			href={page.url.href}
			alertsAvailable={data.provider != null && providerHasAlerts(data.provider)}
			officialAlertsUrl={data.provider?.alert_links[locale]}
			record={data.record}
		/>
	{:else}
		<ScreenTitle title={overviewCopy[locale].title(city)} />
		<div data-slot="screen-state"><StateMark state="not_measured" {locale} /></div>
	{/if}
</Surface>
