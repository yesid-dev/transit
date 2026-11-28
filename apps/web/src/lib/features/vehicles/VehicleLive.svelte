<script lang="ts">
	import { stopDisplayName } from '#lib/site/transitDisplay.ts';
	import RecordGroup from '#lib/features/record/RecordGroup.svelte';
	import FactList from '#lib/features/record/FactList.svelte';
	import FactRow from '#lib/features/record/FactRow.svelte';
	import { DashboardGrid } from '@yesid/ui/layout';
	import { AnswerLead, RoutePlate, StatusMark } from '@yesid/ui/brand';
	import RecordAnswer from '#lib/features/record/RecordAnswer.svelte';
	import { Skeleton } from '@yesid/ui/skeleton';
	import RecordCard from '#lib/features/record/RecordCard.svelte';
	import StateMark from '#lib/features/record/StateMark.svelte';
	import AboutLiveFigures from '#lib/features/record/AboutLiveFigures.svelte';
	import VehicleMapPreview from './VehicleMapPreview.svelte';
	import { vehicleLocationRoute } from './vehicleLocationRoute.ts';
	import {
		tickingLiveStamp,
		liveStatusWords,
		recordDate,
		relativeReportAge,
	} from '#lib/site/presenter.ts';
	import * as Sheet from '@yesid/ui/sheet';
	import { onMount, untrack, type Snippet } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import type { Locale } from '#lib/i18n/index.ts';
	import type { Awaitable } from '#lib/site/ready.ts';
	import type { VehicleLastSeen } from '#lib/server/vehicleRecord.ts';
	import { choose, recordConnection } from '#lib/features/record/recordText.ts';
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
		lastSeen = null,
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
		/** When the record last saw this vehicle in service, for the not-reporting state. */
		lastSeen?: Awaitable<VehicleLastSeen> | null;
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
	const reportsSettled = $derived(
		Boolean(live.vehicles) || live.familyStates.vehicles.phase === 'failed',
	);
	let stops = $state<SlimStopsIndex | null>(null);
	let stopsSettled = $state(false);
	onMount(() => {
		live.start();
		const controller = new AbortController();
		if (id) {
			void getStopsIndexSlim({ manifest, signal: controller.signal })
				.then((result) => (stops = result))
				.catch(() => {})
				.finally(() => (stopsSettled = true));
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
	const settledRoutes = new SvelteSet<string>();
	$effect(() => {
		const want = selected?.route ? [selected.route] : [];
		for (const route of want) {
			if (routes.has(route)) continue;
			routes.set(route, null);
			void getRoute(route, { manifest })
				.then((file) => {
					routes.set(route, file);
					// The map's shapes follow; the cards need only the route's directions.
					settledRoutes.add(route);
					if (id && file)
						void getScheduleShapes([route], { manifest })
							.then((shapes) => routes.set(route, withScheduleShapes(file, shapes)))
							.catch(() => {});
				})
				.catch(() => {})
				.finally(() => settledRoutes.add(route));
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
	// A reporting vehicle is drawn once, with its direction, stop names and departure in hand,
	// or after a short wait without them; until then the page keeps the not-reporting shape.
	let detailsDue = $state(false);
	$effect(() => {
		if (!reportsSettled || detailsDue) return;
		const timer = setTimeout(() => (detailsDue = true), 2500);
		return () => clearTimeout(timer);
	});
	// The trip family can answer before it holds this vehicle's trip; wait for the trip itself.
	const tripsSettled = $derived(
		Boolean(liveReading?.trip && live.index.byTripId.has(liveReading.trip)) ||
			live.familyStates.trips.phase === 'failed',
	);
	const detailsReady = $derived(
		detailsDue ||
			(stopsSettled &&
				(!liveReading?.route || settledRoutes.has(liveReading.route)) &&
				(!liveReading?.trip || tripsSettled)),
	);
	const view = $derived(
		!reportsSettled ? 'waiting' : liveReading ? (detailsReady ? 'reporting' : 'waiting') : 'silent',
	);
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
	// One stamp per screen: the vehicle's report, or the feed's capture when it is not in it.
	const feedTime = $derived(
		live.vehicles?.generated_utc
			? tickingLiveStamp(new Date(live.vehicles.generated_utc), locale, { late: health.isStale })
			: undefined,
	);
	const waitingTime = $derived({
		kind: 'live' as const,
		label: t('Live · loading…', 'En direct · chargement…'),
	});
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
		return t('Not reporting now.', 'Ne se signale pas en ce moment.');
	});
	function lastSeenSentence(seen: VehicleLastSeen) {
		if (seen.kind === 'unavailable') return recordConnection.unreachable[locale];
		if (seen.kind === 'absent')
			return t('No trip in the record on these dates.', 'Aucun trajet au bilan à ces dates.');
		const day = recordDate(seen.day, locale);
		const line = seen.line ? display.line(seen.line) : null;
		return line
			? t(
					`Last seen in the record on ${day}, on line ${line}.`,
					`Vu pour la dernière fois au bilan le ${day}, sur la ligne ${line}.`,
				)
			: t(`Last seen in the record on ${day}.`, `Vu pour la dernière fois au bilan le ${day}.`);
	}
</script>

{#if id}
	{@const mapHref = href('/map?' + new URLSearchParams({ selectedVehicle: id }))}
	<div class="min-w-0" data-slot="screen-content">
		<RecordGroup class="gap-(--space-card-gap)">
			{@render titleBlock?.(view !== 'reporting' || health.isStale ? null : liveReading?.route)}
			{#if view === 'reporting' && liveReading}
				{@const running = liveReading}
				<div data-slot="screen-answer">
					<RecordAnswer
						value={headline?.value ?? null}
						state={readingState}
						sentence={liveSentence}
						{locale}
						time={liveTime ?? feedTime}
					/>
					{#if health.isStale}<p
							class="text-small text-muted-foreground"
							data-slot="last-vehicle-position"
						>
							{t('Last report', 'Dernier signalement')}
							{@render reportedAt()}. {t(
								'The feed is late; this is the last position received.',
								'Le flux est en retard; voici la dernière position reçue.',
							)}
						</p>{/if}
				</div>
				<DashboardGrid gutter={false} minTile="20rem" class="items-start">
					<RecordCard interactive title={t('Where it is', 'Où il se trouve')}>
						<div class="grid content-start gap-3">
							<VehicleMapPreview
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
						</div>
						{#snippet links()}
							<a
								class="inline-flex min-h-11 w-full items-center text-primary underline"
								href={mapHref}
							>
								{t('Show on the map', 'Voir sur la carte')}
							</a>
						{/snippet}
					</RecordCard>
					<RecordCard interactive title={t('What it is running', 'Son service en cours')}>
						<div class="vehicle-running">
							<FactList leading={false} class="[--fact-row-columns:max-content_minmax(0,1fr)]">
								<FactRow label={t('Line', 'Ligne')}>
									{#if running.route}
										{@const line = display.lineName(running.route)}
										<span class="service-line flex min-w-0 items-center justify-end gap-x-2">
											<RoutePlate code={line.number ?? running.route} />
											<a
												class="inline-flex min-h-11 min-w-min items-center font-sans text-primary underline [overflow-wrap:normal] [word-break:normal]"
												href={href(routeFor({ kind: 'line', id: running.route }))}
												>{line.name ?? line.label}</a
											>
										</span>
									{:else}<span class="font-sans">{unknown}</span>{/if}
								</FactRow>
								<FactRow label={t('Scheduled departure', 'Départ prévu')}>
									{#if departure.time}
										{@const from = departureOrigin
											? t(` from ${departureOrigin}`, ` depuis ${departureOrigin}`)
											: ''}
										{#if departureLink}<a
												class="inline-flex min-h-11 items-center text-primary underline [overflow-wrap:normal] [word-break:normal]"
												href={departureLink}
												data-slot="departure-time"
												><span>{departure.time}<span class="font-sans">{from}</span></span></a
											>{:else}<span data-slot="departure-time"
												>{departure.time}<span class="font-sans">{from}</span></span
											>{/if}
									{:else}
										<!-- A missing time is a state, not a link. -->
										<span class="font-sans" data-slot="departure-time-missing"
											>{tripsSettled
												? t('Not in the timetable', 'Absent de l’horaire')
												: t('Time unknown', 'Heure inconnue')}</span
										>
									{/if}
								</FactRow>
								<FactRow label={t('Status', 'État')}>
									<span class="font-sans">
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
									</span>
								</FactRow>
								<FactRow label={t('Next stop', 'Prochain arrêt')}>
									{#if running.next_stop}<a
											class="inline-flex min-h-11 items-center font-sans text-primary underline"
											href={href(routeFor({ kind: 'stop', id: running.next_stop }))}>{nextStop}</a
										>
									{:else}<span class="font-sans">{unknown}</span>{/if}
								</FactRow>
								<FactRow label={t('Room on board', 'Places à bord')}
									><span class="font-sans"
										>{running.occupancy
											? OCCUPANCY_LABELS[locale][running.occupancy]
											: unknown}</span
									></FactRow
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
						</div>
						{#snippet links()}
							{@render viewRecord()}
						{/snippet}
					</RecordCard>
				</DashboardGrid>
			{:else}
				<!-- Waiting keeps the not-reporting shape: one answer line with its stamp, one short card.
				     A reporting vehicle replaces both at once, so nothing already drawn moves. -->
				<div
					class="vehicle-silent-answer"
					data-slot="screen-answer"
					data-record-pending={view === 'waiting' ? '' : undefined}
					aria-busy={view === 'waiting' ? 'true' : undefined}
				>
					<RecordAnswer
						value={null}
						state={view === 'waiting' ? undefined : readingState}
						statement={view === 'waiting' ? waitingStatement : undefined}
						sentence={view === 'waiting' ? t('Loading…', 'Chargement…') : liveSentence}
						{locale}
						time={view === 'waiting' ? waitingTime : (liveTime ?? feedTime ?? waitingTime)}
					/>
				</div>
				<DashboardGrid gutter={false} minTile="20rem" class="items-start">
					<RecordCard interactive title={t('In the record', 'Au bilan')}>
						<div class="vehicle-last-seen" data-slot="vehicle-last-seen">
							{#if view === 'waiting'}<div class="grid gap-2" aria-hidden="true">
									<Skeleton class="h-4 w-full max-w-72" />
									<Skeleton class="h-4 w-48 max-w-full" />
								</div>
							{:else}
								<p>
									{#if lastSeen}{#await lastSeen}<span class="sr-only"
												>{t('Loading…', 'Chargement…')}</span
											>{:then seen}{lastSeenSentence(seen)}{:catch}{recordConnection.unreachable[
												locale
											]}{/await}{/if}
									{#if readingState === 'not_reporting'}{t(
											'The feed cannot tell whether it is still in service.',
											'Le flux n’indique pas s’il est toujours en service.',
										)}{/if}
								</p>
								{#if report}<p class="text-small text-muted-foreground">
										{t('Last report', 'Dernier signalement')} · {@render reportedAt()}
									</p>{/if}
							{/if}
						</div>
						{#snippet links()}
							{#if recordHref}<a
									class="inline-flex min-h-11 items-center text-primary underline"
									href={recordHref}>{t('This vehicle’s record', 'Le bilan de ce véhicule')}</a
								>{/if}
						{/snippet}
					</RecordCard>
				</DashboardGrid>
			{/if}
		</RecordGroup>
		{#if view !== 'waiting'}<RecordGroup>
				<AboutLiveFigures
					{locale}
					{operator}
					healthLink={href('/status')}
					captureAge={health.ageSeconds}
				/>
			</RecordGroup>{/if}
	</div>
{/if}

<!-- The waiting statement has the state mark's line, empty, so the answer keeps its height. -->
{#snippet waitingStatement()}
	<AnswerLead
		value={null}
		sentence={t('Loading…', 'Chargement…')}
		absent={waitingMark}
		layout="fit"
	/>
{/snippet}
{#snippet waitingMark()}<span
		class="inline-flex min-w-0 items-baseline gap-2 font-semibold"
		aria-hidden="true"><span class="font-mono">&nbsp;</span></span
	>{/snippet}

{#snippet viewRecord()}
	{#if recordHref}<a
			class="inline-flex min-h-11 items-center text-primary underline"
			href={recordHref}
			>{t(
				'This vehicle’s record for the chosen dates',
				'Bilan de ce véhicule pour les dates choisies',
			)}</a
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
	/* The not-reporting state and its waiting shape keep one height: the record sentence takes up
	   to two lines on a wide card and four on a phone. */
	.vehicle-last-seen {
		display: grid;
		align-content: start;
		gap: 0.5rem;
		min-block-size: 2lh;
	}
	@media (width < 40rem) {
		.vehicle-last-seen {
			min-block-size: 4lh;
		}
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
