<script lang="ts">
	import { page } from '$app/state';
	import { Surface } from '@yesid/ui/layout';
	import { SvelteURL } from 'svelte/reactivity';
	import { getLocale } from '#lib/i18n/index.ts';
	import { choose } from '#lib/features/record/recordText.ts';
	import { dateRange } from '#lib/site/presenter.ts';
	import type { loadVehiclePage } from '#lib/server/vehicleRecord.ts';
	import { frameHref } from '#lib/site/frameState.ts';
	import type { Manifest } from '#lib/v1/schemas/index.ts';
	import type { PublicCity } from '#lib/v1/schemas/providers.ts';
	import VehicleLive from './VehicleLive.svelte';
	import VehicleRecord from './VehicleRecord.svelte';
	import { vehicleHref } from './vehicleLinks.ts';
	import { notTracked } from './vehicleText.ts';

	let {
		data,
	}: {
		data: ReturnType<typeof loadVehiclePage> & {
			v1: { manifest: Manifest } | null;
			provider: PublicCity | null;
		};
	} = $props();
	const locale = getLocale();
	const t = (en: string, fr: string) => choose(locale, en, fr);
	// Extend the targets into the header spacing. The navigation keeps wrapped rows apart.
	const detailLink = 'inline-flex min-h-11 -my-2.5 items-center';
	const pinned = $derived.by(() => {
		const url = new SvelteURL(page.url.href);
		url.searchParams.set('provider', data.city);
		url.hash = '';
		return new URL(frameHref(url, { mode: data.mode, period: data.period }), url);
	});
	const title = $derived(
		data.id ? t(`Vehicle ${data.id}`, `Véhicule ${data.id}`) : t('Vehicles', 'Véhicules'),
	);
	const notTrackedLive = $derived(
		data.provider?.inputs.vehicle_positions === false ||
			data.provider?.inputs.stable_vehicle_ids === false,
	);
</script>

<Surface>
	<div class="grid min-w-0 gap-4">
		<header class="grid gap-2">
			{#if data.id}
				<a
					class={`${detailLink} justify-self-start`}
					href={vehicleHref('/vehicles', pinned, locale, data.city)}
					>{t('All vehicles', 'Tous les véhicules')}</a
				>
			{/if}
			<h1>{title}</h1>
			<nav
				aria-label={t('Vehicle views', 'Vues des véhicules')}
				class={data.id ? 'flex flex-wrap gap-x-4 gap-y-5' : 'flex flex-wrap gap-4'}
			>
				<a
					class={data.id ? detailLink : undefined}
					aria-current={data.mode === 'live' ? 'page' : undefined}
					href={frameHref(pinned, { mode: 'live', period: data.period })}
					>{t('Live now', 'En direct')}</a
				>
				<a
					class={data.id ? detailLink : undefined}
					aria-current={data.mode === 'record' ? 'page' : undefined}
					href={frameHref(pinned, { mode: 'record', period: data.period })}
					>{t('See the record', 'Voir le bilan')}</a
				>
			</nav>
			{#if data.mode === 'record' && data.period}<p>{dateRange(data.period, locale)}</p>{/if}
		</header>
		{#if data.mode === 'record'}
			<VehicleRecord {data} {locale} {title} url={pinned} />
		{:else if notTrackedLive}
			<p>{notTracked[locale]}</p>
		{:else if data.v1}
			{#key data.city}
				<VehicleLive
					manifest={data.v1.manifest}
					timeZone={data.provider?.timezone ?? data.v1.manifest.tz ?? 'UTC'}
					id={data.id}
					{locale}
					url={pinned}
					city={data.city}
				/>
			{/key}
		{:else}
			<p>
				{t(
					'Live reports are temporarily unavailable.',
					'Les signalements en direct sont temporairement indisponibles.',
				)}
			</p>
		{/if}
	</div>
</Surface>
