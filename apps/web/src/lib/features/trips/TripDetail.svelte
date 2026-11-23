<script lang="ts">
	import { readPublicSiteConfig } from '#lib/site/config.ts';
	import { untrack } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { getLocale, getLocalizeHref, type Locale } from '#lib/i18n/index.ts';
	import { transitTerms } from '#lib/i18n/transitTerms.copy.ts';
	import { mapHrefFor, routeFor } from '#lib/nav/index.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { liveAbsenceReason } from '#lib/site/absence.ts';
	import { livePresentation } from '#lib/v1/live/livePresentation.ts';
	import { LIVE_FAMILIES } from '#lib/v1/live/store.svelte.ts';
	import { createLiveResource } from '#lib/v1/live/resource.ts';
	import { getV1Context } from '#lib/v1/boot.ts';
	import { getRoute, getStopsIndex } from '#lib/v1/repositories/static.ts';
	import { createResource } from '#lib/v1/resource.svelte.ts';
	import type { RouteFile, StopsIndex } from '#lib/v1/index.ts';
	import { usePageTitle } from '#lib/seo/pageTitle.ts';
	import { ArticleHeader, DetailFrame } from '@yesid/ui/layout';
	import { ResourceBoundary, FreshnessStamp } from '#lib/components/surface/index.ts';
	import { StatusBadge } from '#lib/components/dataviz/index.ts';
	import { MaybeValue } from '#lib/components/edge/index.ts';
	import { StateNotice } from '@yesid/ui/feedback';
	import MapDrilldownLink from '#lib/components/surface/MapDrilldownLink.svelte';
	import RecordCopyButton from '#lib/features/lines/reliability/sections/RecordCopyButton.svelte';
	import { formatUtc } from '#lib/utils/time.ts';
	import { delayMeasurement } from '#lib/site/delayPresentation.ts';
	import MetricInfo from '#lib/features/metrics/MetricInfo.svelte';
	import { tripDirection } from './tripDirection';
	import { tripCopy } from './trips.copy';
	import { reportedOffset, tripReportCsv } from './tripReportCsv';
	import TripPredictionTable from './TripPredictionTable.svelte';

	let { id, embedded = false }: { id: string; embedded?: boolean } = $props();
	const locale: Locale = getLocale();
	const t = $derived(tripCopy[locale]);
	const { manifest, provider } = getV1Context();
	const reportTimeZone = provider?.timezone ?? manifest.tz ?? 'UTC';
	const localizeHref = getLocalizeHref();
	const display = transitDisplay();
	const { live, resource: trips } = createLiveResource(
		manifest,
		'trips',
		untrack(() => ({ kind: 'trip', id })),
	);
	$effect(() => {
		live.setTripScope({ kind: 'trip', id });
	});
	const presentation = $derived(
		livePresentation({
			familyStates: live.familyStates,
			families: LIVE_FAMILIES,
			timeZone: reportTimeZone,
			locale,
			page: 'trip',
		}),
	);
	const trip = $derived(trips.data?.trips?.[id] ?? null);
	const routeRequests = new SvelteMap<string, Promise<RouteFile | null>>();
	let resolved = $state<{ tripId: string; routeId: string; file: RouteFile | null } | null>(null);
	$effect(() => {
		const tripId = id;
		const routeId = trip?.route;
		if (!routeId) return;
		let active = true;
		let pending = untrack(() => routeRequests.get(routeId));
		if (!pending) {
			pending = getRoute(routeId).catch(() => null);
			routeRequests.set(routeId, pending);
		}
		void pending.then((file) => {
			if (active) resolved = { tripId, routeId, file };
		});
		return () => {
			active = false;
		};
	});
	const routeFile = $derived(
		resolved?.tripId === id && resolved.routeId === trip?.route ? resolved.file : null,
	);
	const identity = $derived(trip?.route ? display.lineName(trip.route, routeFile?.long) : null);
	const lineLabel = $derived(
		identity && (identity.number || identity.name)
			? identity.spoken
			: trip?.route
				? t.lineId(trip.route)
				: null,
	);
	const predictions = $derived(trip?.stops ?? []);
	const direction = $derived(
		tripDirection(
			predictions.map((stop) => stop.stop),
			routeFile?.directions ?? [],
		),
	);
	usePageTitle(() =>
		embedded
			? null
			: [t.reportTitle, lineLabel ?? t.heading(id), direction].filter(Boolean).join(' · '),
	);
	const stopsIndex = createResource<StopsIndex | null>(() => getStopsIndex());
	const stopNames = $derived(
		Object.fromEntries((stopsIndex.data?.stops ?? []).map((stop) => [stop.id, stop.name])),
	);
	const offset = $derived(reportedOffset(trip?.delay_min));
	const unknownStatusAndDelay = $derived(trip?.status === 'unknown' && offset === null);
	const generatedUtc = $derived(
		trips.data?.generated_utc && Number.isFinite(Date.parse(trips.data.generated_utc))
			? trips.data.generated_utc
			: null,
	);
	const absoluteTime = $derived(
		generatedUtc
			? formatUtc(generatedUtc, locale, {
					year: 'numeric',
					month: 'short',
					day: 'numeric',
					hour: 'numeric',
					minute: '2-digit',
					second: '2-digit',
					timeZoneName: 'short',
					timeZone: reportTimeZone,
				})
			: null,
	);
	const currentReport = $derived(
		live.familyStates.trips.phase === 'ready' &&
			live.familyStates.trips.health.state === 'live' &&
			live.familyStates.trips.health.retained &&
			!live.familyStates.trips.health.isStale &&
			live.familyStates.trips.health.notice === null,
	);
	const href = (path: string) => localizeHref(path, locale, manifest.provider);
	const lineRecordHref = $derived(
		trip?.route ? href(routeFor({ kind: 'line', id: trip.route })) : null,
	);
	const liveLink = $derived(
		new URL(href(routeFor({ kind: 'trip', id })), readPublicSiteConfig().siteOrigin).href,
	);
	const csv = $derived(
		trip
			? 'data:text/csv;charset=utf-8,' +
					encodeURIComponent(
						tripReportCsv({
							provider: manifest.provider,
							tripId: id,
							trip,
							report: trips.data,
							timeZone: reportTimeZone,
							stopNames,
						}),
					)
			: null,
	);
</script>

{#snippet copyLiveLink()}
	<div class="trip-copy-action">
		<RecordCopyButton
			label={t.copyLive}
			done={t.linkCopied}
			fallbackLabel={t.copyFallback}
			text={liveLink}
		/>
		<p class="trip-live-hint">{t.changing}</p>
	</div>
{/snippet}

{#snippet lineContext(placement: 'summary' | 'rail')}
	<div class="trip-line-context">
		{#if lineRecordHref}
			<p class="trip-line-identity">{lineLabel}</p>
			{#if direction}<p class="trip-direction">{t.toward(direction)}</p>{/if}
			<a
				class="trip-record-link"
				class:trip-record-link--summary={placement === 'summary'}
				href={lineRecordHref}>{t.lineRecord}</a
			>
		{:else}
			<MaybeValue
				value={null}
				reason={liveAbsenceReason('trip-route', { familyStates: live.familyStates })}
				{locale}
				variant="row"
			/>
		{/if}
	</div>
{/snippet}

<DetailFrame
	class="trip-report"
	measure="46rem"
	rule="dimension"
	style="--detail-rail-top: calc(var(--chrome-offset, 0px) + var(--announcement-height, 0px));"
>
	{#snippet header()}
		{#if embedded}
			<h2>{t.reportTitle}</h2>
		{:else}<ArticleHeader
				presentation="reading"
				category={t.kicker}
				title={t.reportTitle}
				subtitle={t.subheading}
				backHref={href('/lines')}
				backLabel={t.back}
				meta={[t.heading(id), manifest.short_name?.trim() || manifest.display_name]}
				titleId="trip-title"
			/>{/if}
	{/snippet}
	{#snippet right()}
		<section class="trip-context" aria-label={t.contextHeading}>
			<h2>{t.contextHeading}</h2>
			{@render lineContext('rail')}
		</section>
	{/snippet}
	{#if live.familyStates.trips.refreshing}
		<p role="status">{transitTerms[locale].refreshingTripData}</p>
	{/if}
	<ResourceBoundary resource={trips} lang={locale}>
		{#snippet children(_file)}
			<div class="trip-body">
				{#if presentation.notice.kind !== 'none'}
					<StateNotice
						title={presentation.notice.message}
						body={presentation.notice.body}
						tone={presentation.notice.tone}
						presentation="silo"
						role="status"
						aria-live="polite"
						data-testid="trip-report-notice"
					/>
				{/if}
				<div class="trip-report-time" data-slot="trip-report-time">
					<p>
						{t.reportTime}: {#if generatedUtc}<time datetime={generatedUtc}>{absoluteTime}</time
							>{:else}{t.timeUnavailable}{/if}
					</p>
					{#if generatedUtc}<FreshnessStamp
							variant="live"
							presentation={presentation.stamp}
							{locale}
							class="trip-report-stamp"
						/>{/if}
				</div>
				{#if trip === null}
					<section
						class="trip-standdown"
						data-testid="trip-standdown"
						aria-label={t.standDownHeading}
					>
						<h2>{t.standDownHeading}</h2>
						<p>{currentReport ? t.standDownBody : t.standDownShown}</p>
						<div class="trip-recovery">
							<a href={href('/lines')}>{t.findLine}</a><a href={href('/search')}>{t.search}</a>
						</div>
						{@render copyLiveLink()}
					</section>
				{:else}
					<div class="trip-summary">
						{@render lineContext('summary')}
						<div class="trip-delay-report">
							<h2>{t.reportedDelay}</h2>
							<div class="trip-verdict">
								<StatusBadge
									status={trip.status}
									label={t.status[trip.status]}
									mode={unknownStatusAndDelay ? 'dot' : 'legend'}
									aria-hidden={unknownStatusAndDelay || undefined}
								/>
								<span class="trip-verdict-delay"
									><MaybeValue
										value={delayMeasurement(offset)}
										variant={unknownStatusAndDelay ? 'row' : 'inline'}
										reason={liveAbsenceReason('trip-delay', { familyStates: live.familyStates })}
										{locale}
									/></span
								>
							</div>
						</div>
					</div>
					<div class="trip-head-actions">
						{@render copyLiveLink()}
						<a
							class="trip-action"
							href={csv}
							download={'trip-' + encodeURIComponent(id) + '-all-predictions.csv'}>{t.download}</a
						>
						<MapDrilldownLink
							href={href(mapHrefFor({ trip: id }, locale))}
							context={t.viewTripOnMap(id)}
							label={t.viewOnMap}
						/>
					</div>
					<section class="trip-stops-section" aria-label={t.reportedPredictions}>
						<div class="trip-section-heading">
							<h2>{t.reportedPredictions}</h2>
							<MetricInfo
								metricKey="tripPredictions"
								{locale}
								name={t.reportedPredictions}
								side="bottom"
							/>
						</div>
						<p class="trip-observed-caveat">{t.observedCaveat}</p>
						<p class="trip-prediction-caveat">{t.predictionCaveat}</p>
						<p class="trip-prediction-count">{t.predictionCount(predictions.length)}</p>
						{#if predictions.length}
							{#key id}<TripPredictionTable
									{predictions}
									{stopNames}
									{locale}
									provider={manifest.provider}
									timeZone={reportTimeZone}
									absenceReason={liveAbsenceReason('trip-delay', {
										familyStates: live.familyStates,
									})}
								/>{/key}
						{:else}<StateNotice
								title={t.noPredictions}
								presentation="silo"
								role="status"
								aria-live="polite"
								data-testid="trip-no-stops"
							/>{/if}
					</section>
				{/if}
			</div>
		{/snippet}
	</ResourceBoundary>
</DetailFrame>

<style>
	.trip-copy-action {
		display: grid;
		gap: 0.5rem;
		min-width: 0;
	}
	.trip-live-hint {
		margin: 0;
		max-width: var(--measure-body);
		color: var(--muted-foreground);
		font-size: var(--text-small);
		line-height: 1.5;
	}
	.trip-head-actions {
		align-items: flex-start;
	}
	.trip-body {
		display: grid;
		gap: 1.5rem;
		min-width: 0;
	}
	.trip-report-time p,
	.trip-line-context p,
	.trip-standdown p,
	.trip-stops-section p {
		margin: 0;
		line-height: 1.5;
	}
	.trip-report-time,
	.trip-line-context,
	.trip-delay-report,
	.trip-standdown {
		display: grid;
		gap: 0.5rem;
	}
	.trip-summary {
		display: grid;
		gap: 1.5rem;
	}
	.trip-line-identity {
		font-weight: 600;
	}
	.trip-direction,
	.trip-prediction-caveat {
		color: var(--muted-foreground);
	}
	.trip-verdict,
	.trip-head-actions,
	.trip-recovery,
	.trip-section-heading {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem 1rem;
	}
	.trip-verdict-delay {
		color: var(--muted-foreground);
		font-variant-numeric: tabular-nums;
	}
	.trip-stops-section {
		display: grid;
		gap: 0.75rem;
		min-width: 0;
	}
	h2 {
		margin: 0;
		font-family: var(--font-heading);
		font-size: var(--text-subheading);
		font-weight: 600;
	}
	.trip-record-link,
	.trip-action,
	.trip-recovery a {
		display: inline-flex;
		min-height: 2.75rem;
		align-items: center;
		color: var(--accent-text);
		text-underline-offset: 0.2em;
	}
	@media (--desktop-min) {
		.trip-record-link--summary {
			display: none;
		}
	}
	a:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}
	:global(.trip-report-stamp) {
		max-width: 100%;
		flex-wrap: wrap;
	}
	.trip-context {
		display: grid;
		gap: 1rem;
	}
</style>
