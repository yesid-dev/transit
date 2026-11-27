<script lang="ts">
	import { stopDisplayName } from '#lib/site/transitDisplay.ts';
	import RecordGroup from '#lib/features/record/RecordGroup.svelte';
	import FactList from '#lib/features/record/FactList.svelte';
	import FactRow from '#lib/features/record/FactRow.svelte';
	import { DashboardGrid } from '@yesid/ui/layout';
	import { RoutePlate, StatusMark } from '@yesid/ui/brand';
	import RecordAnswer from '#lib/features/record/RecordAnswer.svelte';
	import RecordSkeleton from '#lib/features/record/RecordSkeleton.svelte';
	import RecordCard from '#lib/features/record/RecordCard.svelte';
	import StateMark from '#lib/features/record/StateMark.svelte';
	import AboutLiveFigures from '#lib/features/record/AboutLiveFigures.svelte';
	import VehicleStillMap from './VehicleStillMap.svelte';
	import {
		delayReading,
		tickingLiveStamp,
		liveStatusWords,
		relativeReportAge,
	} from '#lib/site/presenter.ts';
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
	import { bestShapeForPoint, routeShapes } from '#lib/components/map/vehicleShapes.ts';
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
	import { vehicleStatus } from './vehicleText.ts';

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

	const liveReading = $derived(selected && !silent && !health.isStale ? selected : null);
	const liveDelay = $derived(
		liveReading?.delay_min == null
			? null
			: liveReading.delay_min === 0
				? t('On time', 'À l’heure')
				: delayReading(liveReading.delay_min * 60, locale),
	);
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
			? tickingLiveStamp(new Date(report), locale, { late: !liveReading })
			: undefined,
	);
	const next = $derived.by(() => {
		if (!liveReading?.next_stop) return undefined;
		const stop = stops?.stops.find(({ id }) => id === liveReading?.next_stop);
		if (stop) return stop;
		const { next_stop_lat: lat, next_stop_lon: lon } = liveReading;
		return lat != null && lon != null
			? { lat, lon, name: nextStop ?? liveReading.next_stop }
			: undefined;
	});

	const shape = $derived.by(() => {
		if (!liveReading?.route) return null;
		const route = routes.get(liveReading.route);
		return route ? bestShapeForPoint(routeShapes(route), [liveReading.lon, liveReading.lat]) : null;
	});
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
	const liveSentence = $derived(
		liveReading
			? [
					liveDelay
						? t('against the timetable', 'par rapport à l’horaire')
						: t('Delay unknown', 'Retard inconnu'),
					liveReading.route
						? t(
								`on line ${display.line(liveReading.route)}${toward}`,
								`sur la ligne ${display.line(liveReading.route)}${toward}`,
							)
						: null,
				]
					.filter(Boolean)
					.join(', ') + '.'
			: !live.vehicles
				? live.familyStates.vehicles.phase === 'failed'
					? t(
							'Live reports are temporarily unavailable.',
							'Les signalements en direct sont temporairement indisponibles.',
						)
					: t('Loading live reports…', 'Chargement des signalements en direct…')
				: health.isStale
					? t(
							'The latest feed is delayed. Current vehicle activity is unknown.',
							'Le flux est en retard. L’activité actuelle des véhicules est inconnue.',
						)
					: t(
							'This vehicle is not reporting now. The feed cannot tell whether it is still in service.',
							'Ce véhicule ne se signale pas en ce moment. Le flux n’indique pas s’il est toujours en service.',
						),
	);
</script>

{#if id}
	{@render titleBlock?.(liveReading?.route)}
	<div class="min-w-0" data-slot="screen-content">
		<RecordGroup>
			<div data-slot="screen-answer">
				{#if waitingForReports}
					<div class="grid min-w-0 gap-4" data-record-pending>
						<RecordSkeleton shape="reading" />
						<RecordSkeleton shape="trend" />
						<RecordSkeleton shape="facts" />
						<p role="status">{liveSentence}</p>
					</div>
				{:else}
					<RecordAnswer
						value={liveDelay}
						state={readingState}
						sentence={liveSentence}
						{locale}
						time={liveTime}
					/>
				{/if}
				{#if readingState === 'not_reporting' && report}<p>
						{t('Last report', 'Dernier signalement')} · {@render reportedAt()}
					</p>{/if}
			</div>
			{#if liveReading}
				{@const running = liveReading}
				<DashboardGrid gutter={false} minTile="20rem">
					<RecordCard interactive title={t('Where it is', 'Où il se trouve')} stamp={liveTime}>
						<div class="grid gap-3">
							<VehicleStillMap
								vehicle={running}
								line={running.route ? display.line(running.route) : undefined}
								{next}
								{previous}
								{shape}
								{locale}
							/>
							{#if previous && next}
								<p>
									{t(
										`Between ${previous.name} and ${next.name}${toward ? ', heading' + toward : ''}.`,
										`Entre ${previous.name} et ${next.name}${toward ? ',' + toward : ''}.`,
									)}
								</p>
							{/if}
						</div>
						{#snippet links()}
							<a
								class="inline-flex min-h-11 w-full items-center text-primary underline"
								href={href(routeFor({ kind: 'vehicle', id }))}
							>
								{t('Open the full map on this vehicle', 'Ouvrir la carte sur ce véhicule')}
							</a>
						{/snippet}
					</RecordCard>
					<RecordCard
						interactive
						title={t('What it is running', 'Son service en cours')}
						stamp={liveTime}
					>
						<FactList leading={false}>
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
							<FactRow label={t('How full it is', 'Places à bord')}
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
						{#snippet links()}
							{@render viewRecord()}
						{/snippet}
					</RecordCard>
				</DashboardGrid>
			{:else if !waitingForReports}
				{@render viewRecord()}
			{/if}
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
