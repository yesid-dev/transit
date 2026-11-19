<script lang="ts">
	import { createRecordStamp } from '#lib/v1/recordStamp.svelte.ts';
	import ArticleHeader from '#lib/components/layout/TransitArticleHeader.svelte';
	import { stopDisplayName } from '#lib/site/transitDisplay.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	const display = transitDisplay();
	import { provideLiveAbsenceContext } from '#lib/site/absence.ts';
	import { getV1Runtime } from '#lib/v1/runtime.ts';
	const clock = getV1Runtime().clock;
	import { feedPresentation } from '#lib/v1/live/livePresentation.ts';
	import { providerHasAlerts, routeHasNoLiveData } from '#lib/v1/providers.ts';
	import { CollapsibleSection, type TocEntry } from '@yesid/ui/brand';
	import { Button } from '@yesid/ui/button';
	import { onMount, untrack } from 'svelte';
	import { page } from '$app/state';
	import { getLocale, getLocalizeHref, type Locale } from '#lib/i18n/index.ts';
	import type { DetailTab } from '#lib/site/detailTabs.ts';
	import { createDetailTabController } from '#lib/site/detailTabController.svelte.ts';
	import { getStop } from '#lib/v1/repositories/static.ts';
	import {
		getPublishedReliabilityIndex,
		getStopReliability,
	} from '#lib/v1/repositories/historic.ts';
	import type { LiveStore, LiveFamily } from '#lib/v1/live/store.svelte.ts';
	import { createLiveResource } from '#lib/v1/live/resource.ts';
	import { getV1Context } from '#lib/v1/boot.ts';
	import { historyRangeRequestFromSearchParams } from '#lib/v1/history/rangeResource.svelte.ts';
	import type { StopFile, StopReliability, StopDeparture } from '#lib/v1/index.ts';
	import { createResource, type ResourceSeed } from '#lib/v1/resource.svelte.ts';
	import { ScheduleTable, type ScheduleRow } from '#lib/components/schedule/index.ts';
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
	import type { IdentitySeed } from '#lib/v1/serverContext.ts';
	import { mapHrefFor, routeFor } from '#lib/nav/index.ts';
	import MetricDisplay from '#lib/components/brand/MetricDisplay.svelte';
	import { stampDate } from '#lib/v1/stamp.ts';
	import { StopReliabilitySurface } from './reliability';
	import {
		createStopHistoryResource,
		type StopHistoryResource,
	} from './reliability/data/stopHistoryResource.svelte';
	import { detailCopy } from './stops.copy';
	import { presentStopRecord } from './stopRecord';
	import { stopAccess, stopNotices } from './stopIdentity';
	import StopIdentity from './StopIdentity.svelte';
	import StopRecordAnswer from './StopRecordAnswer.svelte';
	import StopLivePredictions from './StopLivePredictions.svelte';
	import { presentStopLive, type StopLiveOrder } from './stopPredictions';
	import { alertUnavailableCopy } from '#lib/components/surface/alertAvailabilityCopy.ts';

	const localizeHref = getLocalizeHref();

	interface StopDetailProps {
		id: string;
		seed: IdentitySeed;
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

	const manifest = getV1Context().manifest;
	const shortName = manifest.short_name?.trim() || manifest.display_name;
	const operator = $derived(provider?.labels[locale].operator ?? shortName);
	const noticesHeading = $derived(t.notices.heading(operator));

	const SCHEDULE_CAP = 30;

	const tabs = $derived([
		{ key: 'reliability', label: t.tabs.reliability },
		{ key: 'detail', label: t.tabs.detail },
		{ key: 'schedule', label: t.tabs.schedule },
	] as const satisfies readonly { key: DetailTab; label: string }[]);
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
	const scheduleTocEntries = $derived<TocEntry[]>([
		{
			id: 'stop-schedule-service',
			title: t.schedule.heading,
			level: 2,
			badge: { kind: 'number', value: 1 },
			children: [],
		},
	]);
	const articleToc = $derived({
		entries: { detail: detailTocEntries, schedule: scheduleTocEntries },
		heading: articleNav.heading,
		sectionKey: `stop-${id}-toc`,
		counterPrefix: 'SEC',
		openAria: articleNav.openAria,
		closeAria: articleNav.closeAria,
	});

	const detailTabController = createDetailTabController(new URL(page.url.href));
	$effect(() => detailTabController.syncFromUrl(new URL(page.url.href)));

	const { live, resource: departureReport } = createLiveResource(manifest, 'departures');
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
	const recordUrl = $derived(new URL(localizeHref(stopPath, locale), page.url.origin).href);
	// The Live now view holds the full notices; the strip elsewhere leads there.
	const onLive = $derived(detailTabController.active === 'detail');
	const noticeHref = $derived(
		`${localizeHref(`${stopPath}?tab=detail`, locale)}#stop-detail-notices`,
	);

	// The same published weekly row the home page's "Most delayed stops" reads.
	const weeklyIndex = createResource((signal) => getPublishedReliabilityIndex({ signal }), {
		key: () => 'stop-weekly-record',
	});
	const recordAnswer = $derived(
		presentStopRecord({ stopId: id, index: weeklyIndex, now: clock.serverNow }, locale, {
			operator: shortName,
			stopId: id,
			stopCode: stop.data?.code ?? null,
			stopName: articleTitle,
			url: recordUrl,
		}),
	);

	const reliability = createResource((signal) => getStopReliability(id, { signal }), {
		key: () => id,
	});
	const record = createRecordStamp(
		() => manifest,
		() => reliability.data?.generated_utc ?? null,
		() => stopHistory,
		() => detailTabController.active === 'reliability',
	);
	const articleEdgeLeft = $derived([t.kicker, stop.data?.code].filter(Boolean).join(' '));
	const articleMeta = $derived.by<ArticleMetaEntry[]>(() => {
		const values: ArticleMetaEntry[] = [
			...(stop.data?.code ? [{ label: t.info.code, text: stop.data.code }] : []),
			{ label: t.article.provider, text: shortName },
		];
		const stamp = detailTabController.active === 'reliability' ? record.meta(locale) : null;
		if (stamp) values.push(stamp);
		if (detailTabController.active === 'schedule' && stop.data?.generated_utc) {
			const date = stop.data.generated_utc.slice(0, 10);
			values.push({
				text: t.schedule.loadedOn(stampDate(date, locale, manifest.tz)),
				datetime: date,
			});
		}
		return values;
	});

	function historyFor(stopId: string): StopHistoryResource {
		return createStopHistoryResource(
			stopId,
			historyRangeRequestFromSearchParams(new URLSearchParams(page.url.search)),
		);
	}
	const initialHistoryEntityId = untrack(() => id);
	let historyEntityId = initialHistoryEntityId;
	let stopHistory = $state.raw<StopHistoryResource>(historyFor(initialHistoryEntityId));
	$effect(() => {
		const stopId = id;
		if (stopId === historyEntityId) return;
		const previous = stopHistory;
		historyEntityId = stopId;
		stopHistory = historyFor(stopId);
		previous.destroy();
	});
	onMount(() => () => stopHistory.destroy());
	const stopHistoryRequested = $derived(stopHistory.request.hasFrom || stopHistory.request.hasTo);
	const historyOnlyReliability = $derived.by<StopReliability | null>(() => {
		if (!stopHistoryRequested) return null;
		const generatedUtc =
			stopHistory.index?.generated_utc ??
			reliability.data?.generated_utc ??
			stop.data?.generated_utc;
		return generatedUtc == null ? null : { id, generated_utc: generatedUtc };
	});
	const reliabilityIsEmpty = (value: StopReliability | null): boolean =>
		value == null ||
		((value.periods?.length ?? 0) === 0 &&
			(value.habits?.matrix?.length ?? 0) === 0 &&
			value.occupancy_mix == null &&
			(value.day_of_week?.length ?? 0) === 0 &&
			(value.by_route?.length ?? 0) === 0 &&
			(value.daily?.length ?? 0) === 0);

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
			lineHasNoLiveData: (line) =>
				routeHasNoLiveData(manifest.provider, display.directory.type(line)),
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
			presentation={feedPresentation(source.familyStates[family], locale)}
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

{#snippet historicStatus()}
	{#if reliability.data && reliability.error}
		<StateNotice
			title={t.report.historicRefreshUnavailable}
			body={t.report.retainedHistoric}
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
							alerts={notices.direct.map((notice) => notice.alert)}
							{locale}
							copy={{ ...t.alerts, heading: t.notices.direct, listLabel: t.notices.direct }}
							testId="stop-alerts"
						/>
						{#if notices.lines.length > 0}
							<div class="stop-line-notices" data-testid="stop-line-alerts">
								<AffectedAlerts
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

{#snippet stopSummary(onRecord: boolean)}
	<div class="stop-summary" data-slot="stop-summary">
		<StopIdentity
			{locale}
			lines={servedLines}
			{access}
			{operator}
			current={alertsAvailable && !onLive ? notices.current : []}
			{noticeHref}
			record={onRecord}
		/>
		{#if onRecord}
			<StopRecordAnswer
				view={recordAnswer}
				{locale}
				url={recordUrl}
				sourceHref={reliability.data != null || historyOnlyReliability != null
					? '#stop-rel-source'
					: null}
			/>
			{@render historicStatus()}
		{/if}
	</div>
{/snippet}

<EntityDetail
	{tabs}
	{articleToc}
	bind:active={detailTabController.active}
	paneOwnedRailKeys={['reliability']}
>
	{#snippet articleHeader()}
		<ArticleHeader
			watermark={t.article.watermark}
			category={t.kicker}
			title={articleTitle}
			backHref={localizeHref('/stops', locale)}
			backLabel={t.back}
			meta={articleMeta}
			metaPending={detailTabController.active === 'reliability' && record.pending}
			notice={detailTabController.active === 'reliability' ? record.notice(locale) : null}
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
			<div class="stop-lead">{@render stopSummary(false)}</div>
			<ArticleSectionStack>
				{#key id}
					<CollapsibleSection
						title={t.live.heading}
						headerVariant="article-summary"
						index={0}
						subtitle={t.live.changing}
						anchor="stop-detail-departures"
					>
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
												timeZone={manifest.tz}
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
							<a href={localizeHref(stopPath, locale)}>{t.live.record}</a>
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
		{:else if key === 'schedule'}
			<div class="stop-lead">{@render stopSummary(false)}</div>
			<ArticleSectionStack data-section-sequence="stop-schedule">
				{#key id}
					<CollapsibleSection
						title={t.schedule.heading}
						headerVariant="article-summary"
						index={0}
						subtitle={t.questions.schedule}
						anchor="stop-schedule-service"
					>
						<ResourceBoundary resource={stop} lang={locale}>
							{#snippet children(s: StopFile | null)}
								<div class="stop-schedule">
									{@render staticStatus()}
									<p class="stop-report-note">{t.schedule.scope}</p>

									{#if (s?.scheduled?.length ?? 0) === 0}
										<StateNotice
											title={t.schedule.none}
											presentation="silo"
											data-testid="stop-schedule-empty"
										/>
									{:else}
										<ScheduleTable
											mode="grid"
											rows={(s?.scheduled ?? []).map(
												(entry): ScheduleRow => ({
													kind: 'grid',
													route: entry.route,
													headsign: entry.headsign,
													times: entry.times ?? [],
												}),
											)}
											{locale}
											labels={t.schedule.table}
											cap={SCHEDULE_CAP}
											moreLabel={t.schedule.moreTimes}
										/>
									{/if}
								</div>
							{/snippet}
						</ResourceBoundary>
					</CollapsibleSection>
				{/key}
			</ArticleSectionStack>
		{:else if key === 'reliability'}
			<!-- The record's answer stays in one place while the reliability file loads, fails or arrives. -->
			<div class="stop-lead">{@render stopSummary(true)}</div>

			{#if reliability.settled && reliability.error == null && reliabilityIsEmpty(reliability.data) && historyOnlyReliability != null && stopHistory.state !== 'current'}
				{#key id}
					<StopReliabilitySurface
						data={historyOnlyReliability}
						{locale}
						recordWindow={recordAnswer.window}
						history={stopHistory}
						syncUrl={detailTabController.active === 'reliability'}
					/>
				{/key}
			{:else}
				<ResourceBoundary resource={reliability} lang={locale} isEmpty={reliabilityIsEmpty}>
					{#snippet children(r: StopReliability | null)}
						{#if r != null}
							{#key id}
								<StopReliabilitySurface
									data={r}
									{locale}
									recordWindow={recordAnswer.window}
									history={stopHistory}
									syncUrl={detailTabController.active === 'reliability'}
								/>
							{/key}
						{/if}
					{/snippet}
				</ResourceBoundary>
			{/if}
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

	/* Each view leads with the stop summary as a full-width block; the record answer sizes to it. */
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

	.stop-schedule {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
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
