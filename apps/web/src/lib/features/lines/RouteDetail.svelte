<script lang="ts">
	import { readPublicSiteConfig } from '#lib/site/config.ts';
	import LineSchedule from './LineSchedule.svelte';
	import { lineViewsCopy } from './lineViews.copy';
	import RecordCopyButton from './reliability/sections/RecordCopyButton.svelte';
	import { Button } from '@yesid/ui/button';
	import '#lib/components/surface/compact-row.css';
	import ArticleHeader from '#lib/components/layout/TransitArticleHeader.svelte';
	import { liveTimingFor } from '#lib/components/map/liveTiming.ts';
	import { liveReader } from '#lib/v1/adapter/index.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	const { lineName } = transitDisplay();
	import { notReporting } from '#lib/components/map/vehicleProjection.ts';
	import { provideLiveAbsenceContext, liveAbsenceReason } from '#lib/site/absence.ts';
	import { feedPresentation, livePresentation } from '#lib/v1/live/livePresentation.ts';
	import { LIVE_FAMILIES } from '#lib/v1/live/store.svelte.ts';
	import { getV1Runtime } from '#lib/v1/runtime.ts';
	const clock = getV1Runtime().clock;
	import { onMount } from 'svelte';
	import { currentMirrorUrl } from '#lib/site/urlMirror.ts';
	import { getLocale, getLocalizeHref } from '#lib/i18n/index.ts';

	import { mapHrefFor, routeFor } from '#lib/nav/index.ts';
	import { createLiveStore } from '#lib/v1/live/store.svelte.ts';
	import { providerHasAlerts } from '#lib/v1/providers.ts';
	import { deriveRouteStopPredictions } from '#lib/v1/live/routeStopPredictions.ts';
	import { getRoute } from '#lib/v1/repositories/static.ts';
	import { getProvenance } from '#lib/v1/repositories/provenance.ts';
	import { getV1Context } from '#lib/v1/boot.ts';
	import { alertsForRoute } from '#lib/v1/affectedAlerts.ts';
	import type { RouteFile, Provenance, StopPrediction, Vehicle } from '#lib/v1/index.ts';
	import { createResource, type ResourceSeed } from '#lib/v1/resource.svelte.ts';
	import type { IdentitySeed } from '#lib/v1/serverContext.ts';
	import { minutesSinceMidnight } from '#lib/utils/time.ts';

	import { inferAbsenceReason } from '#lib/site/serviceWindow.ts';
	import { EdgeState, MaybeValue } from '#lib/components/edge/index.ts';
	import {
		EntityDetail,
		ResourceBoundary,
		MapDrilldownLink,
		FreshnessStamp,
		AffectedAlerts,
	} from '#lib/components/surface/index.ts';
	import { StatusBadge } from '#lib/components/dataviz/index.ts';
	import { ArticleSectionStack, type ArticleMetaEntry } from '#lib/components/layout/index.ts';

	import { CollapsibleSection, type TocEntry, SectionHeading } from '@yesid/ui/brand';
	import { articleNavigationCopy } from '#lib/components/shared/index.ts';
	import SectionsToggle from '#lib/components/shared/SectionsToggle.svelte';

	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import { detailCopy } from './lines.copy';
	import LineDirections from './LineDirections.svelte';
	import { absenceSentence } from '#lib/site/absence.ts';
	import { delayMeasurement } from '#lib/site/delayPresentation.ts';
	import { STATUS_LABELS } from '#lib/v1/enumLabels.ts';

	const localizeHref = getLocalizeHref();

	interface RouteDetailProps {
		id: string;
		seed: IdentitySeed;
		routeSeed?: ResourceSeed<RouteFile | null>;
	}

	let { id, routeSeed }: RouteDetailProps = $props();

	const locale = getLocale();
	const t = $derived(detailCopy[locale]);
	const viewCopy = $derived(lineViewsCopy[locale]);

	const route = createResource<RouteFile | null>(() => getRoute(id), {
		key: () => id,
		seed: () => routeSeed,
	});
	const titleName = $derived(lineName(id, route.data?.id === id ? route.data.long : null));
	const articleTitle = $derived(titleName.label);
	const v1 = getV1Context();
	const manifest = v1.manifest;
	const timeZone = v1.provider?.timezone ?? manifest.tz ?? 'UTC';
	const l10n = { locale, timeZone };
	const live = createLiveStore(manifest, liveReader, {
		tripScope: untrack(() => ({ kind: 'line', id })),
		families: providerHasAlerts(v1.provider)
			? ['vehicles', 'trips', 'alerts', 'network']
			: ['vehicles', 'trips', 'network'],
	});
	$effect(() => {
		live.setTripScope({ kind: 'line', id });
	});
	provideLiveAbsenceContext(() => ({ familyStates: live.familyStates }));
	const presentation = $derived(
		livePresentation({
			familyStates: live.familyStates,
			families: LIVE_FAMILIES,
			locale,
			timeZone,
		}),
	);
	onMount(() => {
		live.start();
		return () => live.stop();
	});

	const shortName = manifest.short_name?.trim() || manifest.display_name;
	const articleEdgeLeft = $derived([t.kicker, titleName.number].filter(Boolean).join(' '));

	const articleMeta = $derived<readonly ArticleMetaEntry[]>(
		shortName ? [{ label: t.article.provider, text: shortName }] : [],
	);

	const predictions = $derived<ReadonlyMap<string, StopPrediction>>(
		deriveRouteStopPredictions(id, live.index),
	);

	const routeAlerts = $derived(alertsForRoute(live.alerts?.alerts, id));
	const currentAlertReport = $derived(
		live.alerts != null &&
			live.familyStates.alerts.phase === 'ready' &&
			live.familyStates.alerts.health.state === 'live' &&
			live.familyStates.alerts.health.retained &&
			!live.familyStates.alerts.health.isStale &&
			live.familyStates.alerts.health.notice == null,
	);

	const provenance = createResource<Provenance>(() => getProvenance());

	const routeNonResponding = $derived(
		(live.network?.non_responding_by_route ?? []).some((r) => r.route_id === id),
	);

	const absenceReason = $derived(
		inferAbsenceReason({
			providerId: v1.manifest.provider,
			routeType: route.data?.type ?? null,
			gaps: provenance.data?.gaps ?? null,
			firstDeparture: route.data?.first_departure ?? null,
			lastDeparture: route.data?.last_departure ?? null,
			nowMinutes: minutesSinceMidnight(new Date(clock.serverNow), timeZone),
			nonResponding: routeNonResponding,
		}),
	);

	const roster = $derived.by<Vehicle[]>(() => {
		const ids = live.index.vehiclesByRoute.get(id);
		if (!ids) return [];
		const out: Vehicle[] = [];
		for (const vid of ids) {
			const v = live.index.byVehicleId.get(vid);
			if (v) out.push(v);
		}
		return out.sort((a, b) => delaySortKey(b.delay_min) - delaySortKey(a.delay_min));
	});

	function delaySortKey(delay: number | null | undefined): number {
		return delay == null ? Number.NEGATIVE_INFINITY : delay;
	}

	const noLiveData = $derived(absenceReason?.key === 'metro-no-realtime');
	const articleEdgeRight = shortName;

	const hasListColumn = $derived(roster.length > 0 || routeAlerts.length > 0);
	const recordHref = $derived.by(() => {
		const url = currentMirrorUrl();
		url.searchParams.delete('tab');
		url.searchParams.delete('view');
		url.searchParams.set('frameMode', 'record');
		url.searchParams.set('provider', manifest.provider);
		return url.pathname + url.search + url.hash;
	});
	const shareUrl = $derived.by(() => {
		const url = new URL(recordHref, readPublicSiteConfig().siteOrigin);
		url.searchParams.set('frameMode', 'live');
		url.searchParams.set('tab', 'detail');
		return url.href;
	});
	const scheduleLoadedUtc = $derived(
		provenance.data?.sources?.find((source) => source.feed === 'static_schedule')
			?.last_loaded_utc ?? null,
	);
	const articleNav = $derived(articleNavigationCopy[locale]);
	const detailTocEntries = $derived.by<TocEntry[]>(() => {
		if (route.data == null) return [];
		const entries: TocEntry[] = [
			{
				id: 'line-detail-profile',
				title: viewCopy.live,
				level: 2,
				badge: { kind: 'number', value: 1 },
				children: [],
			},
			{
				id: 'line-detail-directions',
				title: viewCopy.predictions,
				level: 2,
				badge: { kind: 'number', value: 3 },
				children: [],
			},
		];
		if (hasListColumn) {
			entries.push({
				id: 'line-detail-live',
				title: viewCopy.roster,
				level: 2,
				badge: { kind: 'number', value: 2 },
				children: [],
			});
		}
		return [entries[0], ...entries.slice(2), entries[1]];
	});
	const articleToc = $derived({
		entries: {
			detail: detailTocEntries,
		},
		heading: articleNav.heading,
		sectionKey: `line-${id}-toc`,
		counterPrefix: 'SEC',
		openAria: articleNav.openAria,
		closeAria: articleNav.closeAria,
	});

	const showAbsenceNote = $derived(roster.length === 0);

	const tripHref = (tripId: string): string =>
		localizeHref(routeFor({ kind: 'trip', id: tripId }), locale);
</script>

<EntityDetail tabs={[{ key: 'detail', label: t.tabs.detail }]} {articleToc} active="detail">
	{#snippet articleHeader()}
		<ArticleHeader
			watermark={t.article.watermark}
			category={t.kicker}
			title={articleTitle}
			highlight={titleName.number ?? undefined}
			backHref={localizeHref('/lines', locale)}
			backLabel={t.article.back}
			meta={articleMeta}
			edgeLeft={articleEdgeLeft}
			edgeRight={articleEdgeRight}
			titleId="line-title"
		>
			{#snippet controls()}
				<SectionsToggle />
			{/snippet}
			{#snippet actions()}
				<MapDrilldownLink
					href={localizeHref(mapHrefFor({ route: id }, locale), locale)}
					context={t.viewRouteOnMap(titleName.number ?? titleName.name ?? id)}
					label={t.viewOnMap}
				/>
			{/snippet}
		</ArticleHeader>
	{/snippet}

	{#snippet pane()}
		{#if noLiveData}
			<ResourceBoundary resource={route} lang={locale}>
				{#snippet children(file)}<LineSchedule
						{file}
						{locale}
						noLive
						loadedUtc={scheduleLoadedUtc}
						{recordHref}
						{shareUrl}
					/>{/snippet}
			</ResourceBoundary>
		{:else}
			<ResourceBoundary resource={route} lang={locale}>
				{#snippet children(file)}
					<ArticleSectionStack class="route-live-grid">
						{#key id}
							<CollapsibleSection
								title={viewCopy.live}
								subtitle={viewCopy.changing}
								headerVariant="article-summary"
								index={0}
								anchor="line-detail-profile"
							>
								<div class="route-live-summary">
									<FreshnessStamp variant="live" presentation={presentation.stamp} {locale} />
									<Button
										variant="outline"
										class="min-h-11"
										onclick={() => live.refresh({ force: true })}>{viewCopy.refresh}</Button
									>
									{#if presentation.notice.kind !== 'none'}<p role="status">
											{presentation.notice.message}
											{presentation.notice.body}
										</p>{/if}
									<p class="route-reporting">
										<MaybeValue
											value={live.familyStates.vehicles.health.retained
												? viewCopy.reporting(roster.length)
												: null}
											reason={liveAbsenceReason('vehicle-delay', {
												familyStates: live.familyStates,
											})}
											{locale}
										/>
									</p>
									<a class="route-record-link" href={recordHref}>{viewCopy.record}</a>
									<RecordCopyButton
										label={viewCopy.copyLive}
										done={viewCopy.copied}
										fallbackLabel={viewCopy.copyFallback}
										text={shareUrl}
									/>
									{#if !providerHasAlerts(v1.provider)}<p>
											{viewCopy.alertsUnavailable}
										</p>{:else if !currentAlertReport}<p>
											{viewCopy.alertsUnknown}
										</p>{:else if routeAlerts.length === 0}<p>{viewCopy.noAlerts}</p>{/if}
									<AffectedAlerts
										{timeZone}
										alerts={routeAlerts}
										{locale}
										copy={t.alerts}
										testId="route-alerts"
									/>
									{#if providerHasAlerts(v1.provider) && routeAlerts.length > 0 && live.familyStates.alerts.health.ageSeconds != null}
										<p class="route-alerts-age">
											<FreshnessStamp
												variant="live"
												subject="alerts"
												presentation={feedPresentation(live.familyStates.alerts, locale, timeZone)}
												{locale}
											/>
										</p>
									{/if}
								</div>
							</CollapsibleSection>

							{#if hasListColumn}
								<CollapsibleSection
									title={viewCopy.roster}
									subtitle={viewCopy.offset}
									headerVariant="article-summary"
									index={1}
									anchor="line-detail-live"
								>
									<div class="route-aside">
										{#if roster.length > 0}
											<div class="route-roster" data-testid="route-roster">
												<p class="route-band-definition">{viewCopy.bands}</p>
												<div class="route-section-head">
													<SectionHeading level={2} overline={t.roster.heading} />
													<span class="route-roster-count">{t.roster.count(roster.length)}</span>
												</div>
												<ul class="route-roster-list" aria-label={t.roster.listLabel}>
													{#each roster as bus (bus.id)}
														{@const unknownStatusAndDelay =
															bus.status === 'unknown' && bus.delay_min == null}
														<li class="route-roster-item">
															{#snippet rosterRow()}
																<div class="route-roster-reading">
																	<strong>{t.roster.busLabel(bus.id)}</strong>
																	<StatusBadge
																		status={bus.status}
																		label={STATUS_LABELS[locale][bus.status]}
																		mode={unknownStatusAndDelay ? 'dot' : 'legend'}
																		aria-hidden={unknownStatusAndDelay || undefined}
																		size="sm"
																	/>
																	<span class="route-roster-delay"
																		><MaybeValue
																			value={delayMeasurement(bus.delay_min)}
																			reason={liveAbsenceReason('vehicle-delay', {
																				familyStates: live.familyStates,
																				notReporting:
																					notReporting(
																						bus,
																						clock.serverNow,
																						liveTimingFor(manifest).staleCutoffS,
																					) != null,
																			})}
																			variant="row"
																			{locale}
																		/></span
																	>
																	{#if bus.next_stop != null}<span
																			class="route-roster-next"
																			title={t.roster.nextStop(
																				route.data?.directions
																					?.flatMap((d) => d.stops ?? [])
																					.find((s) => s.id === bus.next_stop)?.name ??
																					bus.next_stop,
																			)}
																			>{t.roster.nextStop(
																				route.data?.directions
																					?.flatMap((d) => d.stops ?? [])
																					.find((s) => s.id === bus.next_stop)?.name ??
																					bus.next_stop,
																			)}</span
																		>{/if}
																</div>
															{/snippet}
															{#if bus.trip}
																<a
																	class="route-roster-link"
																	href={tripHref(bus.trip)}
																	aria-label={`${t.roster.viewTrip(bus.id)}, ${unknownStatusAndDelay ? '' : `${STATUS_LABELS[locale][bus.status]}, `}${t.roster.delay}: ${delayMeasurement(bus.delay_min) ?? absenceSentence(liveAbsenceReason('vehicle-delay', { familyStates: live.familyStates, notReporting: notReporting(bus, clock.serverNow, liveTimingFor(manifest).staleCutoffS) != null }), locale)}`}
																>
																	{@render rosterRow()}
																	<ChevronRightIcon
																		size={14}
																		strokeWidth={2.4}
																		aria-hidden="true"
																	/>
																</a>
															{:else}
																<div class="route-roster-link route-roster-link--static">
																	{@render rosterRow()}
																</div>
															{/if}
															<MapDrilldownLink
																href={localizeHref(mapHrefFor({ vehicle: bus.id }, locale), locale)}
																label={t.roster.mapAction}
																context={t.roster.viewBusOnMap(bus.id)}
															/>
														</li>
													{/each}
												</ul>
											</div>
										{/if}
									</div>
								</CollapsibleSection>
							{/if}
							<CollapsibleSection
								title={viewCopy.predictions}
								headerVariant="article-summary"
								index={2}
								anchor="line-detail-directions"
							>
								<div class="route-section">
									{#if showAbsenceNote}
										<EdgeState
											variant="empty"
											lang={locale}
											layout="mobile"
											emptyReason={absenceReason}
											class="route-absence-note"
										/>
									{/if}
									<LineDirections directions={file.directions} {predictions} {...l10n} copy={t} />
								</div>
							</CollapsibleSection>
						{/key}
					</ArticleSectionStack>
				{/snippet}
			</ResourceBoundary>
		{/if}
	{/snippet}
</EntityDetail>

<style>
	@media (min-width: 72rem) {
		:global(.article-section-stack.route-live-grid[data-slot='article-section-stack']) {
			display: grid;
			grid-template-columns: minmax(0, 7fr) minmax(0, 5fr);
			align-items: start;
		}
		:global(.route-live-grid > [data-toc='line-detail-profile']) {
			grid-column: 1 / -1;
		}
		:global(.route-live-grid > [data-toc='line-detail-directions']) {
			grid-column: 2;
		}
	}
	.route-reporting {
		min-block-size: 3em;
	}
	.route-live-summary {
		display: grid;
		justify-items: start;
		gap: 0.75rem;
	}
	.route-live-summary p,
	.route-band-definition {
		margin: 0;
		line-height: 1.5;
		color: var(--muted-foreground);
	}
	.route-record-link {
		display: inline-flex;
		align-items: center;
		min-height: 2.75rem;
		color: var(--accent-text);
	}
	.route-section {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}
	.route-alerts-age {
		margin: 0;
		font-size: var(--text-caption);
		color: var(--muted-foreground);
	}
	.route-aside {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}
	.route-section-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
	}
	.route-roster {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.route-roster-count {
		flex-shrink: 0;
		font-family: var(--font-mono);
		font-size: var(--text-small);
		color: var(--muted-foreground);
	}
	.route-roster-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.route-roster-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.route-roster-reading {
		font-size: var(--text-card-body);
		display: flex;
		flex: 1;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}
	.route-roster-delay,
	.route-roster-next {
		color: var(--muted-foreground);
		font-family: var(--font-mono);
		font-size: var(--text-small);
	}
	.route-roster-next {
		flex-basis: 100%;
		overflow-wrap: normal;
		word-break: normal;
	}
	.route-roster-link {
		flex: 1 1 auto;
		min-width: 0;
		display: flex;
	}
	.route-roster-link--static {
		cursor: default;
	}
	.route-roster-link :global(svg) {
		flex: none;
		opacity: 0.45;
		transition:
			opacity var(--duration-fast) var(--ease-out),
			transform var(--duration-fast) var(--ease-out);
	}
	a.route-roster-link:hover :global(svg) {
		opacity: 1;
		transform: translateX(2px);
	}
	@media (prefers-reduced-motion: reduce) {
		.route-roster-link,
		.route-roster-link :global(svg) {
			transition: none;
		}
		a.route-roster-link:hover :global(svg) {
			transform: none;
		}
	}
</style>
