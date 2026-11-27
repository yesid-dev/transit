<script lang="ts">
	import { stopDisplayName } from '#lib/site/transitDisplay.ts';
	import RecordGroup from '#lib/features/record/RecordGroup.svelte';
	import FactList from '#lib/features/record/FactList.svelte';
	import FactRow from '#lib/features/record/FactRow.svelte';
	import { DashboardGrid } from '@yesid/ui/layout';
	import { RoutePlate, StatusMark } from '@yesid/ui/brand';
	import RecordAnswer from '#lib/features/record/RecordAnswer.svelte';
	import { Skeleton } from '@yesid/ui/skeleton';
	import RecordPending from '#lib/features/record/RecordPending.svelte';
	import RecordCard from '#lib/features/record/RecordCard.svelte';
	import StateMark from '#lib/features/record/StateMark.svelte';
	import AboutLiveFigures from '#lib/features/record/AboutLiveFigures.svelte';
	import FleetLiveAnswer from './FleetLiveAnswer.svelte';
	import VehicleMapPreview from './VehicleMapPreview.svelte';
	import { vehicleLocationRoute } from './vehicleLocationRoute.ts';
	import { tickingLiveStamp, liveStatusWords, relativeReportAge } from '#lib/site/presenter.ts';
	import * as Sheet from '@yesid/ui/sheet';
	import { onMount, untrack, type Snippet } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import type { Locale } from '#lib/i18n/index.ts';
	import { choose } from '#lib/features/record/recordText.ts';
	import { tripDirection } from '#lib/features/trips/tripDirection.ts';
	import LiveTripPredictions from '#lib/features/trips/LiveTripPredictions.svelte';
	import { departureByTripHref, departureHref } from '#lib/features/record/departureIdentity.ts';
	import { vehicleDepartureTiming } from './vehicleDeparture.ts';
	import { liveAbsenceReason } from '#lib/site/absence.ts';
	import { liveTimingFor } from '#lib/components/map/liveTiming.ts';
	import { notReporting } from '#lib/components/map/vehicleProjection.ts';
	import { routeFor } from '#lib/nav/index.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { liveReader } from '#lib/v1/adapter/index.ts';
	import { OCCUPANCY_LABELS } from '#lib/v1/enumLabels.ts';
	import { createLiveStore } from '#lib/v1/live/store.svelte.ts';
	import { getScheduleShapes, withScheduleShapes } from '#lib/v1/repositories/scheduleShapes.ts';
	import { getRoute, getStopsIndexSlim } from '#lib/v1/repositories/static.ts';
	import { getV1Runtime } from '#lib/v1/runtime.ts';
	import type { Manifest, RouteFile, Vehicle } from '#lib/v1/schemas/index.ts';
	import type { SlimStopsIndex } from '#lib/v1/repositories/stopsSlim.ts';
	import { vehicleHref } from './vehicleLinks.ts';
	import { vehicleHeadline, vehicleStatus } from './vehicleText.ts';

	let {
		manifest,
		timeZone,
		id,
		locale,
		url,
		city,
		operator,
		recordHref,
		titleBlock,
	}: {
		manifest: Manifest;
		timeZone: string;
		id?: string;
		locale: Locale;
		url: URL;
		city: string;
		operator?: string;
		recordHref?: string;
		titleBlock?: Snippet<[string | null | undefined]>;
	} = $props();
	const display = transitDisplay();
	const t = (en: string, fr: string) => choose(locale, en, fr);
	const unknown = $derived(t('Unknown', 'Inconnu'));
	const live = createLiveStore(
		untrack(() => manifest),
		liveReader,
		untrack(() => ({
			families: id ? ['vehicles', 'trips'] : ['vehicles'],
			tripScope: id ? { kind: 'vehicle', id } : null,
		})),
	);
	$effect(() => {
		live.setTripScope(id ? { kind: 'vehicle', id } : null);
	});
	const { clock } = getV1Runtime();
	const cutoff = $derived(liveTimingFor(manifest).staleCutoffS);
	const health = $derived(live.familyStates.vehicles.health);
	const waitingForReports = $derived(
		!live.vehicles && live.familyStates.vehicles.phase !== 'failed',
	);
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

	const selected = $derived(id ? live.index.byVehicleId.get(id) : undefined);
	const stopNames = $derived(
		Object.fromEntries((stops?.stops ?? []).map((stop) => [stop.id, stopDisplayName(stop.name)])),
	);
	const routes = new SvelteMap<string, RouteFile | null>();
	$effect(() => {
		const want = selected?.route ? [selected.route] : [];
		for (const route of want) {
			if (routes.has(route)) continue;
			routes.set(route, null);
			void getRoute(route, { manifest })
				.then(async (file) => {
					routes.set(route, file);
					if (id && file)
						routes.set(
							route,
							withScheduleShapes(file, await getScheduleShapes([route], { manifest })),
						);
				})
				.catch(() => {});
		}
	});

	function directionName(vehicle: Vehicle): string | null {
		const file = vehicle.route ? routes.get(vehicle.route) : null;
		const trip = vehicle.trip ? live.index.byTripId.get(vehicle.trip) : null;
		if (trip?.headsign) return trip.headsign;
		const variants = file?.directions ?? [];
		const inferred = tripDirection(trip?.stops?.map((stop) => stop.stop) ?? [], variants);
		if (inferred) return inferred;
		const reported = variants.filter((variant) => variant.dir === vehicle.direction_id);
		if (reported.length === 1 && reported[0]?.headsign) return reported[0].headsign;
		const matching = variants.filter((variant) =>
			variant.stops?.some((stop) => stop.id === vehicle.next_stop),
		);
		return matching.length === 1 ? (matching[0].headsign ?? null) : null;
	}

	const href = (path: string) => vehicleHref(path, url, locale, city);
	const predictionsLabel = $derived(
		t('Predictions at its next stops', 'Prévisions à ses prochains arrêts'),
	);
	const report = $derived(selected?.reported_utc || selected?.updated_utc);
	const nextStop = $derived(
		selected?.next_stop
			? stops?.stops.find((stop) => stop.id === selected?.next_stop)?.name || selected.next_stop
			: null,
	);
	const silent = $derived(
		selected ? notReporting(selected, clock.serverNow, cutoff) !== null : false,
	);

	const liveReading = $derived(selected && (!silent || health.isStale) ? selected : null);
	const headline = $derived(liveReading ? vehicleHeadline(liveReading, locale) : null);
	const destination = $derived(
		liveReading ? display.directory.headsign(liveReading.route, directionName(liveReading)) : null,
	);
	const toward = $derived(destination ? ` ${display.toward(destination, locale, false)}` : '');
	const currentTrip = $derived(
		liveReading?.trip ? live.index.byTripId.get(liveReading.trip) : undefined,
	);
	const currentRoute = $derived(liveReading?.route ? routes.get(liveReading.route) : null);
	const departure = $derived(
		vehicleDepartureTiming(
			currentTrip ?? undefined,
			currentRoute,
			currentTrip?.direction_id ?? liveReading?.direction_id,
			locale,
			timeZone,
		),
	);
	const departureOrigin = $derived(departure.origin ? stopNames[departure.origin] : undefined);
	const departureLink = $derived.by(() => {
		const trip = liveReading?.trip;
		if (!trip) return null;
		const direct =
			currentTrip?.start_time && currentTrip.route
				? departureHref(
						url,
						locale,
						city,
						currentTrip.route,
						currentTrip.direction_id ?? null,
						currentTrip.start_time,
						'live',
						trip,
					)
				: null;
		return direct ?? departureByTripHref(url, locale, city, trip);
	});
	const liveTime = $derived(
		report && Number.isFinite(Date.parse(report))
			? tickingLiveStamp(new Date(report), locale, { late: !liveReading || health.isStale })
			: undefined,
	);
	const next = $derived.by(() => {
		if (!liveReading?.next_stop) return undefined;
		const stop = stops?.stops.find(({ id }) => id === liveReading?.next_stop);
		if (stop) return stop;
		const { next_stop_lat: lat, next_stop_lon: lon } = liveReading;
		return lat != null && lon != null
			? { id: liveReading.next_stop, lat, lon, name: nextStop ?? liveReading.next_stop }
			: undefined;
	});

	const locationRoute = $derived(
		liveReading
			? vehicleLocationRoute(
					currentRoute,
					currentTrip?.direction_id ?? liveReading.direction_id,
					directionName(liveReading),
					liveReading.next_stop,
				)
			: null,
	);
	const previous = $derived.by(() => {
		if (!liveReading?.next_stop) return undefined;
		const trip = liveReading.trip ? live.index.byTripId.get(liveReading.trip) : null;
		const list = trip?.stops?.map(({ stop }) => stop) ?? [];
		const index = list.indexOf(liveReading.next_stop);
		if (index > 0) return stops?.stops.find(({ id }) => id === list[index - 1]);
		const route = liveReading.route ? routes.get(liveReading.route) : null;
		const matching =
			route?.directions?.filter(
				({ dir, stops }) =>
					dir === liveReading.direction_id && stops?.some(({ id }) => id === liveReading.next_stop),
			) ?? [];
		if (matching.length !== 1) return undefined;
		const ordered = [...(matching[0].stops ?? [])].sort((a, b) => a.seq - b.seq);
		const nextIndex = ordered.findIndex(({ id }) => id === liveReading.next_stop);
		const previousId = ordered[nextIndex - 1]?.id;
		return previousId ? stops?.stops.find(({ id }) => id === previousId) : undefined;
	});
	const readingState = $derived(
		liveReading
			? 'delay_unknown'
			: live.vehicles && !health.isStale
				? 'not_reporting'
				: 'no_live_data',
	);
	const liveSentence = $derived.by(() => {
		if (liveReading && headline) {
			const line = liveReading.route ? display.line(liveReading.route) : null;
			const sentence = [
				headline.timing,
				line ? t(`on line ${line}${toward}`, `sur la ligne ${line}${toward}`) : null,
			]
				.filter(Boolean)
				.join(', ');
			return sentence
				? sentence + '.'
				: t(
						'The last report gave no timetable offset.',
						'Le dernier signalement ne donnait aucun écart à l’horaire.',
					);
		}
		if (!live.vehicles)
			return live.familyStates.vehicles.phase === 'failed'
				? t(
						'Live reports are temporarily unavailable.',
						'Les signalements en direct sont temporairement indisponibles.',
					)
				: t('Loading live reports…', 'Chargement des signalements en direct…');
		if (health.isStale)
			return t(
				'No report from this vehicle yet. Live reports are late.',
				'Aucun signalement de ce véhicule pour l’instant. Les signalements en direct sont en retard.',
			);
		return t(
			'This vehicle is not reporting now. The feed cannot tell whether it is still in service.',
			'Ce véhicule ne se signale pas en ce moment. Le flux n’indique pas s’il est toujours en service.',
		);
	});
</script>

{#if id}
	{@const mapHref = href('/map?' + new URLSearchParams({ selectedVehicle: id }))}
	<div class="min-w-0" data-slot="screen-content">
		<RecordGroup class="gap-(--space-card-gap)">
			{@render titleBlock?.(health.isStale ? null : liveReading?.route)}
			<FleetLiveAnswer {locale} pending={waitingForReports}>
				<RecordAnswer
					value={headline?.value ?? null}
					state={readingState}
					sentence={liveSentence}
					{locale}
					time={liveTime}
				/>
				{#if liveReading && health.isStale}<p
						class="text-small text-muted-foreground"
						data-slot="last-vehicle-position"
					>
						{t('Last report', 'Dernier signalement')}
						{@render reportedAt()}. {t(
							'The feed is late; this is the last position received.',
							'Le flux est en retard; voici la dernière position reçue.',
						)}
					</p>{:else if readingState === 'not_reporting' && report}<p>
						{t('Last report', 'Dernier signalement')} · {@render reportedAt()}
					</p>{/if}
			</FleetLiveAnswer>
			<DashboardGrid gutter={false} minTile="20rem" class="items-start">
				<RecordCard
					interactive
					title={t('Where it is', 'Où il se trouve')}
					class={liveReading || waitingForReports ? 'lg:min-h-[31.25rem]' : undefined}
					stamp={liveTime}
					stampRule
					stampPending={waitingForReports}
				>
					<div
						class="vehicle-location grid content-start gap-3"
						class:reserved={liveReading || waitingForReports}
					>
						{#if waitingForReports}<div data-waiting-shape="map">
								<Skeleton class="h-64 w-full" />
							</div>
							<RecordPending {locale} />
						{:else if liveReading}{@const running = liveReading}<VehicleMapPreview
								vehicle={running}
								{manifest}
								route={locationRoute}
								{next}
								{previous}
								{locale}
								href={mapHref}
							/>
							{#if previous && next}
								<p>
									{t(
										`Between ${previous.name} and ${next.name}${toward ? ', heading' + toward : ''}.`,
										`Entre ${previous.name} et ${next.name}${toward ? ',' + toward : ''}.`,
									)}
								</p>
							{/if}
						{:else}<StateMark state={readingState} {locale} />{/if}
					</div>
					{#snippet links()}
						{#if liveReading || waitingForReports}<a
								class="inline-flex min-h-11 w-full items-center text-primary underline"
								href={mapHref}
							>
								{t('Show on the map', 'Voir sur la carte')}
							</a>{/if}
					{/snippet}
				</RecordCard>
				<RecordCard
					interactive
					title={t('What it is running', 'Son service en cours')}
					class={liveReading || waitingForReports ? 'lg:min-h-[37.125rem]' : undefined}
					stamp={liveTime}
					stampRule
					stampPending={waitingForReports}
				>
					<div class="vehicle-running" class:reserved={liveReading || waitingForReports}>
						{#if waitingForReports}<RecordPending
								{locale}
								shape={{ shape: 'facts', count: 6 }}
							/>{:else if liveReading}{@const running = liveReading}<FactList
								leading={false}
								class="[--fact-row-columns:max-content_minmax(0,1fr)]"
							>
								<FactRow label={t('Line', 'Ligne')}>
									{#if running.route}
										{@const line = display.lineName(running.route)}
										<span class="service-line flex min-w-0 items-center justify-end gap-x-2">
											<RoutePlate code={line.number ?? running.route} />
											<a
												class="inline-flex min-h-11 min-w-min items-center text-primary underline [overflow-wrap:normal] [word-break:normal]"
												href={href(routeFor({ kind: 'line', id: running.route }))}
												>{line.name ?? line.label}</a
											>
										</span>
									{:else}{unknown}{/if}
								</FactRow>
								<FactRow
									label={t('Scheduled departure', 'Départ prévu')}
									detail={departureOrigin
										? t(`from ${departureOrigin}`, `depuis ${departureOrigin}`)
										: undefined}
								>
									{#if departure.time && departureLink}<a
											class="inline-flex min-h-11 items-center text-primary underline [overflow-wrap:normal] [word-break:normal]"
											href={departureLink}>{departure.time + toward}</a
										>
									{:else if departure.time}{departure.time + toward}
									{:else}
										<!-- A missing time is a state, not a link; the departure keeps its own link. -->
										<span data-slot="departure-time-missing"
											>{t('Not given in the live feed', 'Non indiqué dans le flux en direct')}</span
										>
										{#if departureLink}<a
												class="inline-flex min-h-11 items-center text-primary underline"
												href={departureLink}>{t('This departure', 'Ce départ')}</a
											>{/if}
									{/if}
								</FactRow>
								<FactRow label={t('Status', 'État')}>
									{#if running.status === 'unknown'}<StateMark state="delay_unknown" {locale} />
									{:else}<StatusMark
											status={running.status}
											{...liveStatusWords(
												running.status,
												vehicleStatus(running, locale),
												running.delay_min == null ? null : running.delay_min * 60,
												locale,
											)}
										/>{/if}
								</FactRow>
								<FactRow label={t('Next stop', 'Prochain arrêt')}>
									{#if running.next_stop}<a
											class="inline-flex min-h-11 items-center text-primary underline"
											href={href(routeFor({ kind: 'stop', id: running.next_stop }))}>{nextStop}</a
										>
									{:else}{unknown}{/if}
								</FactRow>
								<FactRow label={t('Room on board', 'Places à bord')}
									>{running.occupancy
										? OCCUPANCY_LABELS[locale][running.occupancy]
										: unknown}</FactRow
								>
								<FactRow label={t('Last report', 'Dernier signalement')}
									>{@render reportedAt()}</FactRow
								>
							</FactList>
							{#if running.trip}
								<Sheet.Root>
									<Sheet.Trigger class="inline-flex min-h-11 items-center text-primary underline"
										>{predictionsLabel}</Sheet.Trigger
									>
									<Sheet.Content
										side="bottom"
										closeLabel={t('Close', 'Fermer')}
										class="max-h-[90dvh] overflow-y-auto"
									>
										<Sheet.Title>{t(`Trip ${running.trip}`, `Trajet ${running.trip}`)}</Sheet.Title>
										{#if live.trips}
											<LiveTripPredictions
												inSheet
												id={running.trip}
												report={live.trips}
												{locale}
												provider={city}
												{timeZone}
												{stopNames}
												current={live.familyStates.trips.health.state === 'live'}
												absenceReason={liveAbsenceReason('trip-delay', {
													familyStates: live.familyStates,
												})}
											/>
										{:else}
											<p role="status">
												{live.familyStates.trips.phase === 'failed'
													? t(
															'Predictions are temporarily unavailable.',
															'Les prévisions sont temporairement indisponibles.',
														)
													: t('Loading predictions…', 'Chargement des prévisions…')}
											</p>
										{/if}
									</Sheet.Content>
								</Sheet.Root>
							{/if}
						{:else}<StateMark state={readingState} {locale} />{/if}
					</div>
					{#snippet links()}
						{@render viewRecord()}
					{/snippet}
				</RecordCard>
			</DashboardGrid>
		</RecordGroup>
		<RecordGroup>
			<AboutLiveFigures
				{locale}
				{operator}
				healthLink={href('/status')}
				captureAge={health.ageSeconds}
			/>
		</RecordGroup>
	</div>
{/if}

{#snippet viewRecord()}
	{#if recordHref}<a
			class="inline-flex min-h-11 items-center text-primary underline"
			href={recordHref}
			>{t('Its record over the chosen dates', 'Son bilan pour les dates choisies')}</a
		>{/if}
{/snippet}

{#snippet reportedAt()}
	{#if report && Number.isFinite(Date.parse(report))}
		<time datetime={report}
			>{relativeReportAge((clock.serverNow - Date.parse(report)) / 1000, locale)}</time
		>
	{:else}
		{unknown}
	{/if}
{/snippet}

<style>
	.vehicle-location.reserved {
		min-block-size: 19rem;
	}
	.vehicle-running.reserved {
		min-block-size: 21rem;
	}

	@container (width >= 16rem) {
		.service-line > a {
			inline-size: max-content;
			/* Keep the label, plate and gaps inside the row when a long name wraps. */
			max-inline-size: calc(100cqi - 7rem);
			flex-shrink: 0;
		}
	}
	@container (width < 16rem) {
		.service-line {
			flex-wrap: wrap;
		}
	}
</style>
