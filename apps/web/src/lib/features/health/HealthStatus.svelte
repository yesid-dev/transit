<script lang="ts">
	import ArticleHeader from '#lib/components/layout/TransitArticleHeader.svelte';
	import OutOfServiceVehicles from './OutOfServiceVehicles.svelte';
	import HealthSummary from './HealthSummary.svelte';
	import type { Manifest } from '#lib/v1/schemas/index.ts';
	import { untrack } from 'svelte';
	import { liveReader } from '#lib/v1/adapter/index.ts';
	import { createLiveStore, type LiveStore } from '#lib/v1/live/store.svelte.ts';
	import { getV1Runtime } from '#lib/v1/runtime.ts';
	const clock = getV1Runtime().clock;
	import './sections/health-sections.css';

	import { useAvailableSectionJump } from '#lib/site/availableSectionJump.svelte.ts';
	import { getLocale, getLocalizeHref, type Locale } from '#lib/i18n/index.ts';
	import { freshnessRelative } from '#lib/v1/freshness.ts';
	import { getDataHealth } from '#lib/v1/repositories/dataHealth.ts';
	import { getHistoricAvailability } from '#lib/v1/repositories/historic.ts';
	import { getProvenance } from '#lib/v1/repositories/provenance.ts';
	import type { DataHealth } from '#lib/v1/schemas/data_health.ts';
	import type { HistoricAvailabilityIndex } from '#lib/v1/schemas/history.ts';
	import type { Provenance } from '#lib/v1/schemas/provenance.ts';
	import { createResource, type ResourceSeed } from '#lib/v1/resource.svelte.ts';
	import { formatRelativeSeconds } from '#lib/utils/time.ts';
	import { stampDate } from '#lib/v1/stamp.ts';
	import { METHODOLOGY_METRIC_KEY } from '#lib/features/metrics/metrics.content.ts';
	import {
		ArticleKeywords,
		ArticleSectionStack,
		type ArticleMetaEntry,
	} from '#lib/components/layout/index.ts';
	import { DetailFrame } from '@yesid/ui/layout';
	import { ResourceBoundary } from '#lib/components/surface/index.ts';
	import { SectionLabel, CollapsibleSection, TocNav, type TocEntry } from '@yesid/ui/brand';
	import SectionsToggle from '#lib/components/shared/SectionsToggle.svelte';

	import { copy as COPY } from './health.copy';
	import {
		verdictFor as verdictForRaw,
		freshnessOf,
		sourcesOf,
		gapsOf,
		pipelineNotesOf,
		retentionOf,
	} from './selectors/provenanceViews';
	import { selectLaneRows, type LaneLabels } from './selectors/laneHealth';
	import { selectEnvelope } from './selectors/envelope';
	import { selectHistoryCoverage } from './selectors/historyCoverage';
	import SectionLanes from './sections/SectionLanes.svelte';
	import SectionFreshness from './sections/SectionFreshness.svelte';
	import SectionSources from './sections/SectionSources.svelte';
	import SectionGaps from './sections/SectionGaps.svelte';
	import SectionNotes from './sections/SectionNotes.svelte';
	import SectionRetention from './sections/SectionRetention.svelte';
	import SectionConformance from './sections/SectionConformance.svelte';
	import SectionEnvelope from './sections/SectionEnvelope.svelte';
	import SectionHistoryCoverage from './sections/SectionHistoryCoverage.svelte';

	const localizeHref = getLocalizeHref();

	interface Props {
		manifest?: Manifest;
		provenanceSeed?: ResourceSeed<Provenance>;
		dataHealthSeed?: ResourceSeed<DataHealth>;
		historicAvailabilitySeed?: ResourceSeed<HistoricAvailabilityIndex>;
	}

	let { manifest, provenanceSeed, dataHealthSeed, historicAvailabilitySeed }: Props = $props();

	const PIPELINE_NOTE_KINDS = {
		history_freeze: 'pipeline-note',
		service_time_conversion: 'math',
		alert_text_en: 'definition',
		network_no_data: 'caveat',
		alert_breakdown: 'definition',
		rounding: 'math',
		min_n_rate: 'math',
		wilson_z: 'math',
		service_span: 'definition',
		alert_history_window: 'caveat',
	} as const;

	const locale: Locale = getLocale();
	const t = $derived(COPY[locale]);

	const provenance = createResource(() => getProvenance(), {
		key: () => 'provenance',
		seed: () => provenanceSeed,
	});
	const dataHealth = createResource(() => getDataHealth(), {
		key: () => 'data-health',
		seed: () => dataHealthSeed,
	});
	const historicAvailability = createResource(() => getHistoricAvailability(), {
		key: () => 'historic-availability',
		seed: () => historicAvailabilitySeed,
	});

	function verdictFor(status: string | null | undefined) {
		return verdictForRaw(status, t.statusVerdict);
	}
	function humanizeAge(ageS: number | null | undefined): string {
		return ageS == null ? t.freshness.noAge : formatRelativeSeconds(ageS, locale);
	}
	function lastLoaded(iso: string | null | undefined): string {
		return freshnessRelative(iso, locale, clock.serverNow) ?? t.sources.neverLoaded;
	}
	function humanizeGap(token: string): string {
		return t.gaps.tokens[token] ?? token.replace(/_/g, ' ');
	}
	function fmtDays(v: number | null): string | null {
		return v == null ? null : `${v}${t.retention.daysUnit}`;
	}

	function provenanceIsEmpty(value: Provenance): boolean {
		const windows = retentionOf(value);
		return (
			freshnessOf(value).length === 0 &&
			sourcesOf(value).length === 0 &&
			gapsOf(value).length === 0 &&
			pipelineNotesOf(value, METHODOLOGY_METRIC_KEY, t.pipelineNotes.labels, PIPELINE_NOTE_KINDS)
				.length === 0 &&
			windows.detail == null &&
			windows.aggregate == null &&
			value.conformance == null &&
			value.publish_generation_id == null &&
			value.schema_version == null &&
			value.methodology_version == null
		);
	}

	function dataHealthIsEmpty(value: DataHealth): boolean {
		return (value.lanes?.length ?? 0) === 0 && (value.feeds?.length ?? 0) === 0;
	}

	function historyAvailabilityIsEmpty(value: HistoricAvailabilityIndex): boolean {
		return (value.families?.length ?? 0) === 0;
	}

	const laneLabels = $derived<LaneLabels>({
		laneLabel: (key) => t.lanes.laneLabel[key] ?? key,
		cadence: (key, utc) =>
			t.lanes.cadence[key] ??
			(utc ? t.lanes.lastPublished(stampDate(utc.slice(0, 10), locale, manifest?.tz)) : ''),
		gateVerdict: t.lanes.gateVerdict,
		maintenanceReason: t.lanes.maintenanceReason,
		maintenanceLabel: t.lanes.laneLabel.maintenance,
	});

	// One live vehicles store for the page: the summary's age and the out-of-service count agree.
	let live = $state.raw<LiveStore | null>(null);
	const provider = $derived(manifest?.provider);
	$effect(() => {
		if (!provider) return;
		const store = untrack(() => createLiveStore(manifest!, liveReader, { families: ['vehicles'] }));
		live = store;
		store.start();
		return () => store.stop();
	});

	const prov = $derived(provenance.data ?? null);
	const dh = $derived(dataHealth.data ?? null);
	const historyRoot = $derived(historicAvailability.data ?? null);
	const historyCoverageRows = $derived(selectHistoryCoverage(historyRoot));
	// Data health republishes its feed list every live cycle; provenance ages are frozen daily.
	const freshness = $derived(dh?.feeds?.length ? dh.feeds : prov ? freshnessOf(prov) : []);
	const sources = $derived(prov ? sourcesOf(prov) : []);
	const gaps = $derived(prov ? gapsOf(prov) : []);
	const retention = $derived(prov ? retentionOf(prov) : { detail: null, aggregate: null });
	const conformance = $derived(prov?.conformance ?? null);
	const pipelineNotes = $derived(
		prov
			? pipelineNotesOf(prov, METHODOLOGY_METRIC_KEY, t.pipelineNotes.labels, PIPELINE_NOTE_KINDS)
			: [],
	);
	const hasRetention = $derived(retention.detail != null || retention.aggregate != null);
	const laneRows = $derived(dh ? selectLaneRows(dh, laneLabels) : []);
	const envelope = $derived(
		prov
			? selectEnvelope(prov as Provenance, dh)
			: { generationId: null, schemaVersion: null, methodologyVersion: null },
	);
	const hasEnvelope = $derived(
		envelope.generationId != null ||
			envelope.schemaVersion != null ||
			envelope.methodologyVersion != null,
	);

	const sectionDefs = $derived([
		{
			id: 'health-gaps',
			number: 1,
			title: t.gaps.section,
			subtitle: t.questions.gaps,
			present: gaps.length > 0,
		},
		{
			id: 'health-lanes',
			number: 2,
			title: t.lanes.section,
			subtitle: t.questions.lanes,
			present: laneRows.length > 0,
		},
		{
			id: 'health-freshness',
			number: 3,
			title: t.freshness.section,
			subtitle: t.questions.freshness,
			present: freshness.length > 0,
		},
		{
			id: 'health-sources',
			number: 4,
			title: t.sources.section,
			subtitle: t.questions.sources,
			present: sources.length > 0,
		},
		{
			id: 'health-pipeline-notes',
			number: 5,
			title: t.pipelineNotes.section,
			subtitle: t.questions.pipelineNotes,
			present: pipelineNotes.length > 0,
		},
		{
			id: 'health-retention',
			number: 6,
			title: t.retention.section,
			subtitle: t.questions.retention,
			present: hasRetention,
		},
		{
			id: 'health-conformance',
			number: 7,
			title: t.conformance.section,
			subtitle: t.questions.conformance,
			present: conformance != null,
		},
		{
			id: 'health-envelope',
			number: 8,
			title: t.envelope.section,
			subtitle: t.questions.envelope,
			present: hasEnvelope,
		},
		{
			id: 'health-history-coverage',
			number: 9,
			title: t.historyCoverage.section,
			subtitle: t.questions.historyCoverage,
			present: historyCoverageRows.length > 0,
		},
	]);

	const tocEntries = $derived.by((): TocEntry[] =>
		sectionDefs
			.filter((s) => s.present)
			.map((s) => ({
				id: s.id,
				title: s.title,
				level: 2,
				badge: { kind: 'number' as const, value: s.number },
				children: [],
			})),
	);

	// The summary's lines carry this page's live and record stamps, so the header holds none.
	const articleMeta = $derived<readonly ArticleMetaEntry[]>(
		tocEntries.length > 0 ? [t.article.sections(tocEntries.length)] : [],
	);
	const { navigation, navigate } = useAvailableSectionJump(() => tocEntries);
</script>

<DetailFrame
	class="health-detail"
	railScroll
	toc={{
		entries: tocEntries,
		navigation,
		landFragments: true,
		onNavigate: (id) => {
			void navigate(id);
		},
		openAria: t.toc.pill.open,
		closeAria: t.toc.pill.close,
	}}
>
	{#snippet header()}
		<ArticleHeader
			watermark={t.article.watermark}
			category={t.kicker}
			title={t.heading}
			highlight={t.article.tags[0]}
			backHref={localizeHref('/', locale)}
			backLabel={t.article.back}
			meta={articleMeta}
			metaPending={provenance.loading || dataHealth.loading || historicAvailability.loading}
			titleId="status-title"
		>
			{#snippet controls()}
				<SectionsToggle />
			{/snippet}
		</ArticleHeader>
	{/snippet}

	{#snippet left()}
		<div class="health-left-rail">
			<div class="health-toc-rail">
				{#if tocEntries.length > 0}
					<TocNav
						entries={tocEntries}
						{navigation}
						onNavigate={(id) => {
							void navigate(id);
						}}
						heading={t.toc.label}
						counterPrefix={t.toc.counterPrefix}
					/>
				{/if}
			</div>
			<ArticleKeywords label={t.article.tagsAria} keywords={t.article.tags} />
		</div>
	{/snippet}

	<ArticleSectionStack class="health-sections" data-testid="health-sections">
		<CollapsibleSection
			title={t.overview.title}
			subtitle={t.questions.overview}
			headerVariant="article-summary"
			open={true}
		>
			<div class="health-overview">
				<HealthSummary
					{manifest}
					{live}
					dataHealth={dh}
					historyIndex={historyRoot}
					{gaps}
					{locale}
				/>
				{#if !prov || provenanceIsEmpty(prov)}
					<div class="health-resource-state" aria-label={t.overview.dailyRecord}>
						<SectionLabel text={t.overview.dailyRecord} variant="metric" />
						<ResourceBoundary resource={provenance} lang={locale} isEmpty={provenanceIsEmpty}>
							{#snippet children(_value)}{/snippet}
						</ResourceBoundary>
					</div>
				{/if}
				{#if !dh || dataHealthIsEmpty(dh)}
					<div class="health-resource-state" aria-label={t.overview.liveFeeds}>
						<SectionLabel text={t.overview.liveFeeds} variant="metric" />
						<ResourceBoundary resource={dataHealth} lang={locale} isEmpty={dataHealthIsEmpty}>
							{#snippet children(_value)}{/snippet}
						</ResourceBoundary>
					</div>
				{/if}
				{#if !historyRoot || historyAvailabilityIsEmpty(historyRoot)}
					<div class="health-resource-state" aria-label={t.overview.retainedHistory}>
						<SectionLabel text={t.overview.retainedHistory} variant="metric" />
						<ResourceBoundary
							resource={historicAvailability}
							lang={locale}
							isEmpty={historyAvailabilityIsEmpty}
						>
							{#snippet children(_value)}{/snippet}
						</ResourceBoundary>
					</div>
				{/if}
			</div>
		</CollapsibleSection>

		{@render sectionCard(sectionDefs[0])}
		{#if sectionDefs.slice(1).some((section) => section.present)}
			<CollapsibleSection
				title={t.details}
				headerVariant="article-summary"
				anchor="health-details"
				open={false}
				independent
			>
				<ArticleSectionStack>
					<OutOfServiceVehicles {live} {locale} />
					{#each sectionDefs.slice(1) as section (section.id)}{@render sectionCard(section)}{/each}
				</ArticleSectionStack>
			</CollapsibleSection>
		{/if}
	</ArticleSectionStack>

	{#snippet after()}
		<ArticleKeywords
			class="px-[var(--space-page-x)] pb-8 lg:hidden"
			label={t.article.tagsAria}
			keywords={t.article.tags}
		/>
	{/snippet}
</DetailFrame>

{#snippet sectionCard(section: (typeof sectionDefs)[number])}
	{#if section.present}
		<CollapsibleSection
			title={section.title}
			subtitle={section.subtitle}
			headerVariant="article-summary"
			index={section.number - 1}
			anchor={section.id}
			open={true}
		>
			{#if section.id === 'health-lanes'}
				<SectionLanes rows={laneRows} copy={t} {locale} />
			{:else if section.id === 'health-freshness'}
				<SectionFreshness items={freshness} {verdictFor} {humanizeAge} copy={t} />
			{:else if section.id === 'health-sources'}
				<SectionSources items={sources} {lastLoaded} copy={t} />
			{:else if section.id === 'health-gaps'}
				<SectionGaps {gaps} {humanizeGap} copy={t} />
			{:else if section.id === 'health-pipeline-notes'}
				<SectionNotes notes={pipelineNotes} copy={t} />
			{:else if section.id === 'health-retention'}
				<SectionRetention
					detail={retention.detail}
					aggregate={retention.aggregate}
					{fmtDays}
					copy={t}
					{locale}
				/>
			{:else if section.id === 'health-conformance' && conformance}
				<SectionConformance {conformance} copy={t} {locale} />
			{:else if section.id === 'health-envelope'}
				<SectionEnvelope {envelope} copy={t} {locale} />
			{:else if section.id === 'health-history-coverage'}
				<SectionHistoryCoverage rows={historyCoverageRows} copy={t} {locale} />
			{/if}
		</CollapsibleSection>
	{/if}
{/snippet}

<style>
	:global(.health-detail .section-title) {
		white-space: normal;
		overflow-wrap: normal;
		word-break: normal;
	}
	:global(.health-detail .section-title-group) {
		min-width: 0;
	}
	.health-overview {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
		min-width: 0;
	}
	.health-resource-state {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-width: 0;
	}
	.health-left-rail {
		display: flex;
		flex-direction: column;
		gap: var(--space-card-gap);
		min-width: 0;
	}
	.health-toc-rail {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-width: 0;
	}
</style>
