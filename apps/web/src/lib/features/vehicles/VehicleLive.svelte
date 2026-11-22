<script lang="ts">
	import { Card } from '@yesid/ui/card';
	import { onMount, untrack } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import type { Locale } from '#lib/i18n/index.ts';
	import { choose } from '#lib/features/record/recordText.ts';
	import RecordTable from '#lib/features/record/RecordTable.svelte';
	import { tripDirection } from '#lib/features/trips/tripDirection.ts';
	import { liveTimingFor } from '#lib/components/map/liveTiming.ts';
	import { notReporting } from '#lib/components/map/vehicleProjection.ts';
	import { routeFor } from '#lib/nav/index.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { formatUtc } from '#lib/utils/time.ts';
	import { liveReader } from '#lib/v1/adapter/index.ts';
	import { OCCUPANCY_LABELS } from '#lib/v1/enumLabels.ts';
	import { createLiveStore } from '#lib/v1/live/store.svelte.ts';
	import { isInService } from '#lib/v1/live/vehicleService.ts';
	import { getRoute, getStopsIndexSlim } from '#lib/v1/repositories/static.ts';
	import { getV1Runtime } from '#lib/v1/runtime.ts';
	import type { Manifest, RouteFile, Vehicle } from '#lib/v1/schemas/index.ts';
	import type { SlimStopsIndex } from '#lib/v1/repositories/stopsSlim.ts';
	import { vehicleHref } from './vehicleLinks.ts';
	import { vehicleHeadline, vehicleStatus } from './vehicleText.ts';

	let {
		manifest,
		id,
		locale,
		url,
		city,
	}: {
		manifest: Manifest;
		id?: string;
		locale: Locale;
		url: URL;
		city: string;
	} = $props();
	const display = transitDisplay();
	const t = (en: string, fr: string) => choose(locale, en, fr);
	const unknown = $derived(t('Unknown', 'Inconnu'));
	const live = createLiveStore(
		untrack(() => manifest),
		liveReader,
		{ families: ['vehicles', 'trips'] },
	);
	const { clock } = getV1Runtime();
	const cutoff = $derived(liveTimingFor(manifest).staleCutoffS);
	const health = $derived(live.familyStates.vehicles.health);
	let stops = $state<SlimStopsIndex | null>(null);
	onMount(() => {
		live.start();
		const controller = new AbortController();
		if (id) {
			void getStopsIndexSlim({ manifest, signal: controller.signal })
				.then((result) => (stops = result))
				.catch(() => {});
		}
		return () => {
			controller.abort();
			live.stop();
		};
	});

	let search = $state('');
	let limit = $state(25);
	const selected = $derived(id ? live.index.byVehicleId.get(id) : undefined);
	const active = $derived(
		(live.vehicles?.vehicles ?? []).filter(
			(vehicle) =>
				isInService(vehicle) &&
				!notReporting(vehicle, clock.serverNow, cutoff) &&
				vehicle.id.toLowerCase().includes(search.trim().toLowerCase()),
		),
	);
	const visible = $derived(active.slice(0, limit));
	const routes = new SvelteMap<string, RouteFile | null>();
	$effect(() => {
		const want = new Set(
			(id ? (selected ? [selected] : []) : visible).flatMap((vehicle) =>
				vehicle.route ? [vehicle.route] : [],
			),
		);
		for (const route of want) {
			if (routes.has(route)) continue;
			routes.set(route, null);
			void getRoute(route, { manifest })
				.then((file) => routes.set(route, file))
				.catch(() => {});
		}
	});

	function direction(vehicle: Vehicle): string {
		const file = vehicle.route ? routes.get(vehicle.route) : null;
		const trip = vehicle.trip ? live.index.byTripId.get(vehicle.trip) : null;
		const variants = file?.directions ?? [];
		const inferred = tripDirection(trip?.stops?.map((stop) => stop.stop) ?? [], variants);
		if (inferred) return inferred;
		const matching = variants.filter((variant) =>
			variant.stops?.some((stop) => stop.id === vehicle.next_stop),
		);
		return (matching.length === 1 ? matching[0].headsign : null) ?? unknown;
	}

	const href = (path: string) => vehicleHref(path, url, locale, city);
	const report = $derived(selected?.reported_utc || selected?.updated_utc);
	const nextStop = $derived(
		selected?.next_stop
			? stops?.stops.find((stop) => stop.id === selected?.next_stop)?.name || selected.next_stop
			: null,
	);
	const silent = $derived(
		selected ? notReporting(selected, clock.serverNow, cutoff) !== null : false,
	);
</script>

<Card edge="neutral" textSize="inherit" class="min-w-0 px-4 sm:px-6">
	<section aria-labelledby="vehicle-live-title" class="grid min-w-0 gap-3">
		<h2 id="vehicle-live-title">
			{#if !id}
				{t('Vehicles in service now', 'Véhicules en service maintenant')}
			{:else if selected && !silent && !health.isStale}
				{vehicleHeadline(selected, locale)}
			{:else}
				{t('Current report', 'Signalement actuel')}
			{/if}
		</h2>
		{#if !live.vehicles}
			<p role="status">
				{live.familyStates.vehicles.phase === 'failed'
					? t(
							'Live reports are temporarily unavailable.',
							'Les signalements en direct sont temporairement indisponibles.',
						)
					: t('Loading live reports…', 'Chargement des signalements en direct…')}
			</p>
		{:else if health.isStale}
			<p>
				{t(
					'The latest feed is delayed. Current vehicle activity is unknown.',
					'Le flux est en retard. L’activité actuelle des véhicules est inconnue.',
				)}
			</p>
		{:else if id}
			{#if selected && !silent}
				<dl class="grid gap-3 sm:grid-cols-2">
					<div>
						<dt>{t('Location', 'Position')}</dt>
						<dd>
							<a href={href(routeFor({ kind: 'vehicle', id }))}
								>{t('See this vehicle on the map', 'Voir ce véhicule sur la carte')}</a
							>
						</dd>
					</div>
					<div>
						<dt>{t('Line', 'Ligne')}</dt>
						<dd>
							{#if selected.route}<a href={href(routeFor({ kind: 'line', id: selected.route }))}
									>{display.lineName(selected.route).label}</a
								>{:else}{unknown}{/if}
						</dd>
					</div>
					<div>
						<dt>{t('Direction', 'Direction')}</dt>
						<dd>{direction(selected)}</dd>
					</div>
					<div>
						<dt>{t('Departure', 'Départ')}</dt>
						<dd>
							{#if selected.trip}<a href={href(routeFor({ kind: 'trip', id: selected.trip }))}
									>{t('View trip', 'Voir le voyage')} {selected.trip}</a
								>{:else}{unknown}{/if}
						</dd>
					</div>
					<div>
						<dt>{t('Status', 'État')}</dt>
						<dd>{vehicleStatus(selected, locale)}</dd>
					</div>
					<div>
						<dt>{t('Next stop', 'Prochain arrêt')}</dt>
						<dd>
							{#if selected.next_stop}<a
									href={href(routeFor({ kind: 'stop', id: selected.next_stop }))}>{nextStop}</a
								>{:else}{unknown}{/if}
						</dd>
					</div>
					<div>
						<dt>{t('How full it is', 'Achalandage')}</dt>
						<dd>{selected.occupancy ? OCCUPANCY_LABELS[locale][selected.occupancy] : unknown}</dd>
					</div>
					<div>
						<dt>{t('Last report', 'Dernier signalement')}</dt>
						<dd>{@render reportedAt()}</dd>
					</div>
				</dl>
			{:else}
				<p>
					{t(
						'This vehicle is not reporting now. The feed cannot tell whether it is still in service.',
						'Ce véhicule ne se signale pas en ce moment. Le flux n’indique pas s’il est toujours en service.',
					)}
				</p>
				{#if report}<p>{t('Last report', 'Dernier signalement')} · {@render reportedAt()}</p>{/if}
			{/if}
		{:else}
			<label class="grid max-w-sm gap-1">
				{t('Find by vehicle number', 'Rechercher par numéro de véhicule')}
				<input
					class="min-h-11 rounded-md border border-border px-3"
					type="search"
					bind:value={search}
					oninput={() => (limit = 25)}
				/>
			</label>
			{#if visible.length}
				<p>
					{t(
						`${active.length} vehicles reporting on a trip`,
						`${active.length} véhicules se signalent pendant un voyage`,
					)}
				</p>
				<RecordTable
					title={t('Vehicles in service now', 'Véhicules en service maintenant')}
					headers={[
						t('Vehicle', 'Véhicule'),
						t('Line', 'Ligne'),
						t('Direction', 'Direction'),
						t('Status', 'État'),
					]}
					rows={visible.map((vehicle) => [
						vehicle.id,
						vehicle.route ? display.lineName(vehicle.route).label : unknown,
						direction(vehicle),
						vehicleStatus(vehicle, locale),
					])}
					rowLabel={vehicleLink}
				/>
				{#if active.length > limit}
					<button class="min-h-11 justify-self-start underline" onclick={() => (limit += 25)}
						>{t('Show more vehicles', 'Afficher plus de véhicules')}</button
					>
				{/if}
			{:else}
				<p role="status">
					{search.trim()
						? t('No matching vehicle number.', 'Aucun numéro de véhicule correspondant.')
						: t(
								'No vehicles are currently reporting on a trip.',
								'Aucun véhicule ne se signale pendant un voyage en ce moment.',
							)}
				</p>
			{/if}
		{/if}
	</section>
</Card>

{#snippet vehicleLink(number: string)}
	<a class="inline-flex min-h-11 items-center" href={href(`/vehicle/${encodeURIComponent(number)}`)}
		>{number}</a
	>
{/snippet}

{#snippet reportedAt()}
	{#if report && Number.isFinite(Date.parse(report))}
		<time datetime={report}
			>{formatUtc(report, locale, {
				dateStyle: 'medium',
				timeStyle: 'short',
				timeZone: manifest.tz || 'UTC',
			})}</time
		>
	{:else}
		{unknown}
	{/if}
{/snippet}
