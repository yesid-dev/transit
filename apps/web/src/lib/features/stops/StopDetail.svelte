<script lang="ts">
	import { transitTerms } from '#lib/i18n/transitTerms.copy.ts';
	import ArticleHeader from '#lib/components/layout/TransitArticleHeader.svelte';
	import { stopDisplayName } from '#lib/site/transitDisplay.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	const display = transitDisplay();
	import { provideLiveAbsenceContext } from '#lib/site/absence.ts';
	import { lineIsScheduleOnly } from '#lib/site/providerCapabilities.ts';
	import { getV1Runtime } from '#lib/v1/runtime.ts';
	const clock = getV1Runtime().clock;
	import { feedPresentation } from '#lib/v1/live/livePresentation.ts';
	import { providerHasAlerts } from '#lib/v1/providers.ts';
	import { CollapsibleSection, type TocEntry } from '@yesid/ui/brand';
	import { Button } from '@yesid/ui/button';
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import { getLocale, getLocalizeHref, type Locale } from '#lib/i18n/index.ts';
	import type { DetailTab } from '#lib/site/detailTabs.ts';
	import { stopViewHref } from '#lib/site/stopFrame.ts';
	import { createDetailTabController } from '#lib/site/detailTabController.svelte.ts';
	import { getStop } from '#lib/v1/repositories/static.ts';
	import type { LiveStore, LiveFamily } from '#lib/v1/live/store.svelte.ts';
	import { createLiveResource } from '#lib/v1/live/resource.ts';
	import { getV1Context } from '#lib/v1/boot.ts';
	import type { StopFile, StopDeparture } from '#lib/v1/index.ts';
	import { createResource, type ResourceSeed } from '#lib/v1/resource.svelte.ts';
	import {
		EntityDetail,
		ResourceBoundary,
		FreshnessStamp,
		MapDrilldownLink,
		AffectedAlerts,
	} from '#lib/components/surface/index.ts';
	import { EdgeState } from '#lib/components/edge/index.ts';
	import { StateNotice } from '@yesid/ui/feedback';
	import { ArticleSectionStack, type ArticleMetaEntry } from '#lib/components/layout/index.ts';
	import { articleNavigationCopy } from '#lib/components/shared/index.ts';
	import SectionsToggle from '#lib/components/shared/SectionsToggle.svelte';
	import { desktop } from '@yesid/ui/state';
	import { mapHrefFor, routeFor } from '#lib/nav/index.ts';
	import MetricDisplay from '#lib/components/brand/MetricDisplay.svelte';
	import { detailCopy } from './stops.copy';
	import { stopAccess, stopNotices } from './stopIdentity';
	import StopIdentity from './StopIdentity.svelte';
	import StopLivePredictions from './StopLivePredictions.svelte';
	import { presentStopLive, type StopLiveOrder } from './stopPredictions';
	import { alertUnavailableCopy } from '#lib/components/surface/alertAvailabilityCopy.ts';

	const localizeHref = getLocalizeHref();

	interface StopDetailProps {
		id: string;
		seed: { id: string; name: string };
		stopSeed?: ResourceSeed<StopFile | null>;
	}

	let { id, seed, stopSeed }: StopDetailProps = $props();

	const locale: Locale = getLocale();
	const t = $derived(detailCopy[locale]);
	const unavailableAlerts = $derived(alertUnavailableCopy[locale]);
	const provider = $derived(page.data?.provider);
	const alertsAvailable = $derived(providerHasAlerts(provider));
	const articleNav = $derived(articleNavigationCopy[locale]);
	const edgeLayout = $derived(desktop.current ? 'desktop' : 'mobile');

	const { manifest } = getV1Context();
	const timeZone = $derived(provider?.timezone ?? manifest.tz);
	const shortName = manifest.short_name?.trim() || manifest.display_name;
	const operator = $derived(provider?.labels[locale].operator ?? shortName);
	const noticesHeading = $derived(t.notices.heading(operator));

	const tabs = $derived([{ key: 'detail', label: t.tabs.detail }] satisfies {
		key: DetailTab;
		label: string;
	}[]);
	const detailTocEntries = $derived<TocEntry[]>([
		{
			id: 'stop-detail-departures',
			title: t.live.heading,
			level: 2,
			badge: { kind: 'number', value: 1 },
			children: [],
		},
		{
			id: 'stop-detail-notices',
			title: noticesHeading,
			level: 2,
			badge: { kind: 'number', value: 2 },
			children: [],
		},
		{
			id: 'stop-detail-facts',
			title: t.detailCard.title,
			level: 2,
			badge: { kind: 'number', value: 3 },
			children: [],
		},
	]);
	// The Schedule view has one section: a contents list of one ("1 / 1") navigates nowhere,
	// so it gets no rail card and no phone pill, as a line's Record without sections does.
	const articleToc = $derived({
		entries: { detail: detailTocEntries },
		heading: articleNav.heading,
		sectionKey: `stop-${id}-toc`,
		counterPrefix: 'SEC',
		openAria: articleNav.openAria,
		closeAria: articleNav.closeAria,
	});

	const detailTabController = createDetailTabController(new URL(page.url.href));
	$effect(() => detailTabController.syncFromUrl(new URL(page.url.href)));

	const { live, resource: departureReport } = createLiveResource(
		manifest,
		'departures',
		untrack(() => ({ kind: 'stop', id })),
	);
	$effect(() => {
		live.setTripScope({ kind: 'stop', id });
	});
	provideLiveAbsenceContext(() => ({ familyStates: live.familyStates }));
	const { live: alertLive, resource: alertReport } = createLiveResource(manifest, 'alerts');
	const departures = $derived<readonly StopDeparture[] | null>(
		live.departures ? (live.index.byStopId.get(id) ?? []) : null,
	);

	const stop = createResource((signal) => getStop(id, { signal }), {
		key: () => id,
		seed: () => stopSeed,
	});
	const articleTitle = $derived(
		stopDisplayName(
			seed.name.trim() === id && stop.data?.id === id
				? stop.data.name?.trim() || seed.name
				: seed.name,
		),
	);
	const notices = $derived(
		stopNotices(
			alertLive.alerts?.alerts,
			{ id, code: stop.data?.code, routesServed: stop.data?.routes_served },
			{
				now: clock.serverNow,
				// "Current" needs a fresh report: a retained or failed one cannot say what is in effect.
				reportLive: alertLive.familyStates.alerts.health.state === 'live',
			},
		),
	);
	const access = $derived(stop.data ? stopAccess(stop.data) : stop.settled ? 'unknown' : null);
	const servedLines = $derived(stop.data?.routes_served ?? null);
	const stopPath = $derived(routeFor({ kind: 'stop', id }));
	const recordHref = $derived(stopViewHref(new URL(page.url.href), 'record').href);
	const articleEdgeLeft = $derived([t.kicker, stop.data?.code].filter(Boolean).join(' '));
	const articleMeta = $derived<ArticleMetaEntry[]>([
		...(stop.data?.code ? [{ label: t.info.code, text: stop.data.code }] : []),
		{ label: t.article.provider, text: shortName },
	]);

	let liveOrder = $state<StopLiveOrder>('soonest');
	$effect(() => {
		void id;
		liveOrder = 'soonest';
	});
	const departureHealth = $derived(live.familyStates.departures.health);
	const liveView = $derived(
		presentStopLive({
			departures,
			reportStale: departureHealth.isStale,
			servedLines,
			scheduled: stop.data?.scheduled ?? null,
			lineHasNoLiveData: (line) => lineIsScheduleOnly(provider, line, display.directory.type(line)),
			lineNumber: (line) => display.line(line),
			order: liveOrder,
		}),
	);
	const scheduleHref = $derived(localizeHref(`${stopPath}?tab=schedule`, locale));
	$effect(() => clock.subscribe());
</script>

{#snippet liveStatus(source: LiveStore, family: LiveFamily)}
	{@const health = source.familyStates[family].health}
	<div class="stop-report" data-source={family}>
		<FreshnessStamp
			variant="live"
			presentation={feedPresentation(source.familyStates[family], locale, timeZone)}
			subject={family === 'alerts' ? 'alerts' : 'data'}
			{locale}
			class="stop-report-stamp"
		/>
		{#if health.notice}
			<StateNotice
				title={health.notice === 'refresh-unavailable'
					? t.report.refreshUnavailable
					: t.report.behind}
				body={t.report.retained}
				tone="warning"
				presentation="silo"
				role="status"
				aria-live="polite"
				data-testid={`stop-${family}-notice`}
			/>
		{/if}
	</div>
{/snippet}

{#snippet staticStatus()}
	{#if stop.error && stop.data}
		<StateNotice
			title={t.report.staticRefreshUnavailable}
			body={t.report.retainedStatic}
			tone="warning"
			presentation="silo"
			role="status"
			aria-live="polite"
		/>
	{/if}
{/snippet}

{#snippet stopInformation()}
	<div class="stop-info">
		<ResourceBoundary resource={stop} lang={locale}>
			{#snippet children(s: StopFile | null)}
				{#if s == null}
					<EdgeState variant="empty" lang={locale} layout={edgeLayout} />
				{:else}
					{@render staticStatus()}
					<div class="stop-info-metrics">
						<MetricDisplay value={id} label={t.info.feedId} size="sm" />
						<MetricDisplay
							value={`${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}`}
							label={t.info.position}
							size="sm"
						/>
						{#if s.code}
							<MetricDisplay value={s.code} label={t.info.code} size="sm" />
						{/if}
					</div>
				{/if}
			{/snippet}
		</ResourceBoundary>
	</div>
{/snippet}

{#snippet stopNoticeReport()}
	<div class="stop-alert-report">
		{#if !alertsAvailable}
			<StateNotice
				title={unavailableAlerts.title}
				body={unavailableAlerts.body(operator)}
				presentation="silo"
				role="status"
			>
				{#snippet action()}
					{#if provider?.alert_links[locale]}<a href={provider.alert_links[locale]}
							>{unavailableAlerts.link}</a
						>{/if}
				{/snippet}
			</StateNotice>
		{:else}
			<ResourceBoundary resource={alertReport} lang={locale}>
				{#snippet children(_report)}
					{@render liveStatus(alertLive, 'alerts')}
					{#if stop.data == null}<StateNotice
							title={t.alertState.limited}
							presentation="silo"
						/>{/if}
					{#if notices.direct.length === 0 && notices.lines.length === 0}
						<StateNotice
							title={t.alertState.none}
							presentation="silo"
							data-testid="stop-alerts-empty"
						/>
					{:else}
						<AffectedAlerts
							{timeZone}
							alerts={notices.direct.map((notice) => notice.alert)}
							{locale}
							copy={{ ...t.alerts, heading: t.notices.direct, listLabel: t.notices.direct }}
							testId="stop-alerts"
						/>
						{#if notices.lines.length > 0}
							<div class="stop-line-notices" data-testid="stop-line-alerts">
								<AffectedAlerts
									{timeZone}
									alerts={notices.lines.map((notice) => notice.alert)}
									{locale}
									copy={{ ...t.alerts, heading: t.notices.lines, listLabel: t.notices.lines }}
									testId="stop-line-alerts-list"
								/>
								<p class="stop-report-note">{t.notices.linesScope}</p>
							</div>
						{/if}
					{/if}
				{/snippet}
			</ResourceBoundary>
		{/if}
	</div>
{/snippet}

<EntityDetail {tabs} {articleToc} bind:active={detailTabController.active}>
	{#snippet articleHeader()}
		<ArticleHeader
			watermark={t.article.watermark}
			category={t.kicker}
			title={articleTitle}
			backHref={localizeHref('/stops', locale)}
			backLabel={t.back}
			meta={articleMeta}
			edgeLeft={articleEdgeLeft}
			edgeRight={shortName}
			titleId="stop-title"
		>
			{#snippet controls()}
				<SectionsToggle />
			{/snippet}
			{#snippet actions()}
				<MapDrilldownLink
					href={localizeHref(mapHrefFor({ stop: id }, locale), locale)}
					context={t.viewStopOnMap(stop.data?.code || articleTitle)}
					label={t.viewOnMap}
				/>
			{/snippet}
		</ArticleHeader>
	{/snippet}

	{#snippet pane(key)}
		{#if key === 'detail'}
			<div class="stop-lead">
				<div class="stop-summary" data-slot="stop-summary">
					<StopIdentity {locale} lines={servedLines} {access} />
				</div>
			</div>
			<ArticleSectionStack>
				{#key id}
					<CollapsibleSection
						title={t.live.heading}
						headerVariant="article-summary"
						index={0}
						subtitle={t.live.changing}
						anchor="stop-detail-departures"
					>
						{#if live.familyStates.departures.refreshing}
							<p role="status">{transitTerms[locale].refreshingTripData}</p>
						{/if}
						<ResourceBoundary resource={departureReport} lang={locale}>
							{#snippet children(_report)}
								<div class="stop-next" data-state={liveView.kind}>
									{#if liveView.kind === 'no-capability'}
										<StateNotice
											title={t.live.noCapability}
											body={t.live.noCapabilityBody}
											presentation="silo"
											data-testid="stop-live-state"
										/>
									{:else}
										<div class="stop-live-report">
											{@render liveStatus(live, 'departures')}
											<Button
												variant="outline"
												class="min-h-11 self-start"
												onclick={() => live.refresh({ force: true })}>{t.live.refresh}</Button
											>
										</div>
										{#if liveView.kind === 'list'}
											<StopLivePredictions
												view={liveView}
												bind:order={liveOrder}
												{locale}
												{timeZone}
											/>
										{:else if liveView.kind !== 'pending'}
											<StateNotice
												title={liveView.kind === 'no-service'
													? t.live.noService
													: liveView.kind === 'stale-none'
														? t.live.staleNone
														: t.live.none}
												presentation="silo"
												role="status"
												aria-live="polite"
												data-testid="stop-live-state"
											/>
										{/if}
									{/if}
								</div>
							{/snippet}
						</ResourceBoundary>
						<!-- Outside the report's boundary: the way out stays through every live state. -->
						<p class="stop-live-links">
							<a href={recordHref}>{t.live.record}</a>
							{#if liveView.kind !== 'list'}<a href={scheduleHref}>{t.live.schedule}</a>{/if}
						</p>
					</CollapsibleSection>

					<CollapsibleSection
						title={noticesHeading}
						subtitle={t.notices.question}
						headerVariant="article-summary"
						index={1}
						anchor="stop-detail-notices"
					>
						{@render stopNoticeReport()}
					</CollapsibleSection>

					<CollapsibleSection
						title={t.detailCard.title}
						subtitle={t.detailCard.summary}
						headerVariant="article-summary"
						index={2}
						anchor="stop-detail-facts"
					>
						{@render stopInformation()}
					</CollapsibleSection>
				{/key}
			</ArticleSectionStack>
		{/if}
	{/snippet}
</EntityDetail>

<style>
	.stop-report,
	.stop-alert-report {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-width: 0;
	}
	:global(.stop-report-stamp) {
		max-width: 100%;
		flex-wrap: wrap;
	}
	.stop-report-note {
		margin: 0;
		color: var(--muted-foreground);
		font-size: var(--text-small);
		line-height: 1.5;
	}

	/* The stop identity spans the full content width. */
	.stop-lead {
		inline-size: 100%;
		margin-block-end: var(--space-card-gap);
		container-type: inline-size;
	}
	.stop-summary {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		min-width: 0;
		text-align: start;
	}
	.stop-line-notices {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.stop-next {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.stop-live-report {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-width: 0;
	}
	.stop-live-links {
		display: flex;
		flex-wrap: wrap;
		gap: 0 1.5rem;
		margin: 1rem 0 0;
	}
	.stop-live-links a {
		display: inline-flex;
		align-items: center;
		min-height: var(--size-tap-min);
		color: var(--accent-text);
		text-decoration: underline;
		text-underline-offset: 0.2em;
	}
	.stop-live-links a:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}

	.stop-info {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		min-width: 0;
	}
	.stop-info-metrics {
		display: flex;
		flex-wrap: wrap;
		gap: 1.5rem;
	}
</style>
