<script lang="ts">
	import RecordScreen from '#lib/features/record/RecordScreen.svelte';
	import RecordGroup from '#lib/features/record/RecordGroup.svelte';
	import { page } from '$app/state';
	import { Surface } from '@yesid/ui/layout';
	import { SvelteURL } from 'svelte/reactivity';
	import { getLocale } from '#lib/i18n/index.ts';
	import { dateRange } from '#lib/site/presenter.ts';
	import { choose } from '#lib/features/record/recordText.ts';
	import AboutLiveFigures from '#lib/features/record/AboutLiveFigures.svelte';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import RecordAnswer from '#lib/features/record/RecordAnswer.svelte';
	import ScreenTitle from '#lib/features/record/ScreenTitle.svelte';
	import VehicleDetailRecord from './VehicleDetailRecord.svelte';
	import type { loadVehiclePage } from '#lib/server/vehicleRecord.ts';
	import { frameHref } from '#lib/site/frameState.ts';
	import type { Manifest } from '#lib/v1/schemas/index.ts';
	import type { PublicCity } from '#lib/v1/schemas/providers.ts';
	import VehicleLive from './VehicleLive.svelte';
	import VehicleRecord from './VehicleRecord.svelte';
	import { vehicleHref } from './vehicleLinks.ts';
	import { notTracked, vehicleLines } from './vehicleText.ts';

	let {
		data,
	}: {
		data: ReturnType<typeof loadVehiclePage> & {
			v1: { manifest: Manifest } | null;
			provider: PublicCity | null;
			seoTitle: string;
		};
	} = $props();
	const locale = getLocale();
	const t = (en: string, fr: string) => choose(locale, en, fr);
	const pinned = $derived.by(() => {
		const url = new SvelteURL(page.url.href);
		url.searchParams.set('provider', data.city);
		url.hash = '';
		return new URL(frameHref(url, { mode: data.mode, period: data.period }), url);
	});
	const title = $derived(data.seoTitle);
	const notTrackedLive = $derived(
		data.provider?.inputs.vehicle_positions === false ||
			data.provider?.inputs.stable_vehicle_ids === false,
	);
	const display = transitDisplay();
	const operator = $derived(data.provider?.labels[locale].operator);
	const lineAnswer = $derived(data.sections.find(({ section }) => section === 'lines')?.answer);
	const recordHref = $derived(frameHref(pinned, { mode: 'record', period: data.period }));
	function mostlyOnLine(line: string) {
		const { number, name } = display.lineName(line);
		const label = [number ?? line, name && name !== number ? name : null].filter(Boolean).join(' ');
		return [operator, t(`mostly on line ${label}`, `surtout sur la ligne ${label}`)]
			.filter(Boolean)
			.join(', ');
	}
</script>

{#snippet heading(subtitle: string | undefined)}
	<RecordGroup>
		<ScreenTitle
			{title}
			{subtitle}
			back={{
				href: vehicleHref('/vehicles', pinned, locale, data.city),
				label: t('All vehicles', 'Tous les véhicules'),
			}}
		/>
	</RecordGroup>
{/snippet}

{#snippet liveTitle(line: string | null | undefined)}
	{@render heading(
		line
			? [
					operator,
					t(`on line ${display.line(line)} now`, `sur la ligne ${display.line(line)} en ce moment`),
				]
					.filter(Boolean)
					.join(', ')
			: operator,
	)}
{/snippet}

<Surface>
	<RecordScreen>
		{#if data.id}
			<div class="min-w-0">
				{#if data.mode === 'live' && !notTrackedLive && data.v1}
					{#key data.city}
						<VehicleLive
							manifest={data.v1.manifest}
							timeZone={data.provider?.timezone ?? data.v1.manifest.tz ?? 'UTC'}
							id={data.id}
							{locale}
							url={pinned}
							city={data.city}
							{operator}
							{recordHref}
							titleBlock={liveTitle}
						/>
					{/key}
				{:else}
					{#await lineAnswer}
						{@render heading(operator)}
					{:then result}
						{@const line =
							result?.kind === 'answer' && 'cells' in result.answer && !notTrackedLive
								? vehicleLines(result.answer).find(
										(cell) => cell.state === 'measured' && (cell.value.vehicle_trips_run ?? 0) > 0,
									)?.key.line
								: undefined}
						{@render heading(typeof line === 'string' ? mostlyOnLine(line) : operator)}
					{/await}
					<div class="min-w-0" data-slot="screen-content">
						{#if data.mode === 'record'}
							<VehicleDetailRecord
								{data}
								{locale}
								{title}
								url={pinned}
								trackingDisabled={notTrackedLive}
								{operator}
							/>
						{:else}
							<RecordGroup>
								<div data-slot="screen-answer">
									<RecordAnswer
										value={null}
										state={notTrackedLive ? 'not_tracked' : 'no_live_data'}
										{locale}
										sentence={notTrackedLive
											? notTracked[locale]
											: t(
													'Live reports are temporarily unavailable.',
													'Les signalements en direct sont temporairement indisponibles.',
												)}
									/>
								</div>
								<a
									class="inline-flex min-h-11 items-center justify-self-start text-primary underline"
									href={recordHref}
								>
									{t('Its record over the chosen dates', 'Son bilan pour les dates choisies')}
								</a>
							</RecordGroup>
							<RecordGroup>
								<AboutLiveFigures
									{locale}
									{operator}
									healthLink={vehicleHref('/status', pinned, locale, data.city)}
								/>
							</RecordGroup>
						{/if}
					</div>
				{/if}
			</div>
		{:else}
			<div class="grid min-w-0 gap-4">
				<header class="grid gap-2">
					<h1>{title}</h1>
					<nav aria-label={t('Vehicle views', 'Vues des véhicules')} class="flex flex-wrap gap-4">
						<a
							aria-current={data.mode === 'live' ? 'page' : undefined}
							href={frameHref(pinned, { mode: 'live', period: data.period })}
							>{t('Live now', 'En direct')}</a
						>
						<a
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
		{/if}
	</RecordScreen>
</Surface>
