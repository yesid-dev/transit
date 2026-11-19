<script lang="ts">
	import type { Manifest, RepeatOffenderEntry } from '#lib/v1/schemas/index.ts';
	import { createRecordStamp } from '#lib/v1/recordStamp.svelte.ts';
	import ArticleHeader from '#lib/components/layout/TransitArticleHeader.svelte';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { createReliabilityViewState } from '#lib/reliability/viewState.svelte.ts';
	import { onDestroy } from 'svelte';
	import { page } from '$app/state';
	import { getLocale, getLocalizeHref, intl, type Locale } from '#lib/i18n/index.ts';
	import { transitTerms } from '#lib/i18n/transitTerms.copy.ts';
	import { routeFor } from '#lib/nav/index.ts';
	import { metricInfoCopy, metricInfoFor } from '#lib/metrics.ts';
	import {
		fromSearchParams,
		toSearchParams,
		emptyFilterState,
		type WorstN,
	} from '#lib/filters/index.ts';
	import { availabilityFromPointCollectionIndex } from '#lib/v1/history/selection.ts';
	import { createHistoryCorrectionPresentation } from '#lib/v1/history/datePresentation.svelte.ts';
	import {
		createHistoryDateResource,
		historyDateRequestFromSearchParams,
	} from '#lib/v1/history/dateResource.svelte.ts';
	import {
		getRepeatOffenders,
		getRepeatOffendersHistoryDay,
		getRepeatOffendersHistoryIndex,
	} from '#lib/v1/repositories/historic.ts';
	import type {
		HistoricCollectionIndex,
		RepeatOffenders as RepeatOffendersData,
	} from '#lib/v1/schemas/index.ts';
	import {
		HistoryNavigator,
		ResourceBoundary,
		GrainPicker,
		type GrainSegment,
	} from '#lib/components/surface/index.ts';
	import type { ArticleMetaEntry } from '#lib/components/layout/index.ts';
	import { DetailFrame } from '@yesid/ui/layout';
	import { CollapsibleSection } from '@yesid/ui/brand';
	import SectionsToggle from '#lib/components/shared/SectionsToggle.svelte';
	import { fmtLocalePct } from '#lib/utils/format.ts';
	import { formatDateKey } from '#lib/utils/time.ts';
	import { ladderGrains, OFFENDER_GRAINS } from '#lib/reliability/ladderGrains.ts';
	import { worstNCap, DEFAULT_WORST_N } from '#lib/reliability/ladderCap.ts';
	import { formatDayRange } from '#lib/features/hotspots/selectors/hotspotRanking.ts';
	import {
		readOffenderRanking,
		type OffenderFigures,
		type OffenderKind,
		type RankedOffender,
	} from './selectors/offenderRanking';
	import { offenderIdentity } from './offenderNames';
	import { isMeasured } from './selectors/offenderRanking';
	import RepeatOffendersSection, {
		type OffenderRowView,
	} from './sections/RepeatOffendersSection.svelte';
	import OffenderEvidence, { type OffenderEvidenceView } from './sections/OffenderEvidence.svelte';
	import { copy as COPY } from './repeatOffenders.copy';
	import { offenderGauge } from './offenderGauge';
	import { averageDelay } from './offenderDelay';
	import { EdgeState } from '#lib/components/edge/index.ts';
	import { desktop } from '@yesid/ui/state';
	import { createGaugeHold, gaugeFiller } from '#lib/components/surface/gaugeHold.svelte.ts';

	type Period = (typeof OFFENDER_GRAINS)[number];

	let { manifest = null }: { manifest?: Manifest | null } = $props();
	const display = transitDisplay();
	const localizeHref = getLocalizeHref();
	const locale: Locale = getLocale();
	const t = $derived(COPY[locale]);
	const terms = $derived(transitTerms[locale]);
	const count = (n: number) => intl.number(locale).format(n);

	const offenders = createHistoryDateResource<HistoricCollectionIndex, RepeatOffendersData>(
		{
			loadIndex: (signal) => getRepeatOffendersHistoryIndex({ signal }),
			availability: (index) => availabilityFromPointCollectionIndex(index),
			loadCurrent: (signal) => getRepeatOffenders({ signal }),
			loadDate: (date, index, signal) => getRepeatOffendersHistoryDay(date, index, { signal }),
		},
		{
			initialRequest: historyDateRequestFromSearchParams(new URLSearchParams(page.url.search)),
		},
	);
	onDestroy(() => offenders.destroy());

	const initial = new URLSearchParams(page.url.search);
	let kind = $state<OffenderKind>(initial.get('kind') === 'buses' ? 'vehicle' : 'trip');
	let selectedRef = $state<string | null>(initial.get('selected'));
	let expanded = $state(initial.has('selected'));
	let worstN = $state<WorstN>(fromSearchParams(initial).worstN ?? DEFAULT_WORST_N);

	/**
	 * While the first record loads, the page lays out the gauge record invisibly under a skeleton: every
	 * region takes its loaded room from the first render. When the real record arrives, the page
	 * keeps the gauge's height until the reader acts or the width changes, so nothing below moves.
	 */
	const hold = createGaugeHold(
		() =>
			offenders.data == null &&
			offenders.error == null &&
			(offenders.loading || !offenders.settled),
	);
	const gauge = $derived(hold.active);
	const source = $derived(offenders.data ?? (gauge ? offenderGauge : null));
	// The gauge navigator prints filler shaped like its longest captions, never a date.
	const GAUGE_PICKER = [{ date: '0001-01-01' }];
	const gaugeDays = $derived({
		coverage: gaugeFiller(
			t.history.coverage(formatDateKey('2000-09-30', locale), formatDateKey('2000-09-30', locale)),
		),
		selection: gaugeFiller(t.history.selection(formatDateKey('2000-09-30', locale))),
	});

	const availableDates = $derived(offenders.availableDates);
	const hasHistoryNavigator = $derived(availableDates.length > 0);
	// The ranking waits for history discovery, so its controls never push the rows down later.
	const discovered = $derived(offenders.resolved !== null || offenders.error != null);
	const historyCorrection = createHistoryCorrectionPresentation(
		offenders,
		() => t.history.correction,
	);
	function selectHistoryDate(date: string | undefined): void {
		historyCorrection.clear();
		offenders.setRequest({ hasDate: date !== undefined, rawDate: date ?? null });
	}
	const requestedDate = $derived(
		offenders.request.hasDate && offenders.resolved == null
			? offenders.request.rawDate
			: offenders.canonicalDate,
	);

	const grains = $derived(ladderGrains(source?.by_grain, OFFENDER_GRAINS));
	const view = createReliabilityViewState({
		snapshot: () => offenders.data,
		grains: {
			keys: OFFENDER_GRAINS,
			labels: () => ({ week: t.period.week, month: t.period.month }),
			present: () => grains.present,
		},
		locale: () => locale,
		url: () => {
			const state = emptyFilterState();
			if (worstN !== DEFAULT_WORST_N) state.worstN = worstN;
			return {
				date: requestedDate,
				n: toSearchParams(state).get('n'),
				kind: kind === 'vehicle' ? 'buses' : null,
				selected: selectedRef,
			};
		},
	});
	const period = $derived<Period>(view.grain);
	const ranking = $derived(readOffenderRanking(grains.ladders.get(period), kind));
	const dates = $derived(ranking.state === 'absent' ? null : ranking.period);
	const windowDays = $derived(ranking.state === 'absent' ? null : ranking.windowDays);
	const range = $derived(dates ? formatDayRange(dates.from, dates.to, locale) : null);
	const periodText = $derived.by(() => {
		if (dates && range)
			return t.period.line(range, terms.completeDays(dates.days, count(dates.days)));
		if (windowDays != null)
			return t.period.undated(terms.completeDays(windowDays, count(windowDays)));
		return t.period.unknown;
	});
	const recordSearch = $derived(dates ? `from=${dates.from}&to=${dates.to}` : undefined);
	// The gauge links nowhere: its rows name no real line.
	const lineHref = (route: string | null | undefined) =>
		route?.trim() && !gauge
			? localizeHref(routeFor({ kind: 'line', id: route.trim(), search: recordSearch }), locale)
			: null;
	const refOf = (entry: RepeatOffenderEntry) => `${entry.id}@${entry.route ?? ''}`;

	function lateDaysText(figures: OffenderFigures): string {
		const { lateDays, observedDays } = figures;
		return lateDays == null || observedDays == null
			? t.lateDaysUnknown
			: t.lateDays(lateDays, observedDays, count(lateDays), count(observedDays));
	}
	// An early average reads as early, never as a negative delay (owner ruling 6).
	function averageDelayText(figures: OffenderFigures): string {
		const delay = averageDelay(figures.averageDelayMin, locale);
		if (delay == null) return t.averageDelayUnknown;
		if (delay.direction === 'onTime') return t.averageOnTime;
		return delay.direction === 'early'
			? t.averageEarly(delay.minutes)
			: t.averageDelay(delay.minutes);
	}
	function averageDelayValue(figures: OffenderFigures): string {
		const delay = averageDelay(figures.averageDelayMin, locale);
		if (delay == null) return t.averageDelayUnknown;
		if (delay.direction === 'onTime') return terms.band.onTime;
		return delay.direction === 'early' ? t.evidence.early(delay.minutes) : delay.minutes;
	}
	const readingsText = (figures: OffenderFigures) =>
		figures.readings == null
			? t.readingsUnknown
			: t.readings(figures.readings, count(figures.readings));

	function rowView(row: RankedOffender, eligible: number | null): OffenderRowView {
		const identity = offenderIdentity(row.entry, display.directory, t);
		return {
			key: row.key,
			ref: refOf(row.entry),
			position: row.position,
			positionText: t.ranking.position(
				count(row.position),
				eligible == null ? null : count(eligible),
			),
			number: identity.number,
			primary: identity.primary,
			lineName: identity.lineName,
			label: identity.label,
			lateDaysText: lateDaysText(row.figures),
			averageDelayText: averageDelayText(row.figures),
			href: lineHref(row.entry.route),
		};
	}
	const ranked = $derived(ranking.state === 'ranked' ? ranking.rows : []);
	const rows = $derived(
		ranking.state === 'ranked' ? ranking.rows.map((row) => rowView(row, ranking.eligible)) : [],
	);
	const shownRows = $derived(rows.slice(0, worstNCap(worstN)));
	const selected = $derived(
		shownRows.find((row) => row.ref === selectedRef) ?? shownRows[0] ?? null,
	);
	const defaultCap = worstNCap(DEFAULT_WORST_N);
	const toggle = $derived.by(() => {
		if (shownRows.length < rows.length)
			return {
				label: t.ranking.showAll(kind, count(rows.length)),
				onclick: () => (worstN = 'all'),
			};
		if (worstN !== DEFAULT_WORST_N && rows.length > defaultCap)
			return {
				label: t.ranking.showFewer(kind, count(defaultCap)),
				onclick: () => (worstN = DEFAULT_WORST_N),
			};
		return null;
	});
	const countText = $derived(
		ranking.state === 'ranked'
			? t.ranking.count(
					kind,
					[shownRows.length, count(shownRows.length)],
					[ranking.published, count(ranking.published)],
					ranking.eligible == null ? null : [ranking.eligible, count(ranking.eligible)],
				)
			: '',
	);
	const finding = $derived.by(() => {
		if (ranking.state === 'absent') return t.finding.absent[period];
		if (ranking.state === 'invalid') return t.finding.invalid;
		if (ranking.state === 'none') return t.finding.none[kind];
		return t.finding[kind](rows[0].label);
	});

	const pct = (value: number) => fmtLocalePct(value, locale, { rounding: 'auto' }) ?? '';
	function evidenceOf(row: OffenderRowView): OffenderEvidenceView {
		const figures = ranked.find((item) => item.key === row.key)!.figures;
		const { lateDays, observedDays, readings, lateReadings, latePct, interval } = figures;
		const days = lateDays != null && observedDays != null;
		return {
			figure: days ? t.evidence.figure(count(lateDays), count(observedDays)) : null,
			figureText: days ? t.evidence.lateDays(lateDays, observedDays) : t.lateDaysUnknown,
			averageDelay: averageDelayValue(figures),
			// The late count is never stood in for by the total: unknown stays unknown.
			lateReadings:
				lateReadings == null
					? t.evidence.notPublished
					: readings == null
						? t.readings(lateReadings, count(lateReadings))
						: latePct == null
							? t.evidence.figure(count(lateReadings), readingsText(figures))
							: t.evidence.lateShare(count(lateReadings), readingsText(figures), pct(latePct)),
			readings: lateReadings == null ? readingsText(figures) : null,
			interval: interval
				? t.evidence.intervalValue(pct(interval.lower), pct(interval.upper))
				: t.evidence.notPublished,
			seen:
				observedDays == null
					? t.lateDaysUnknown
					: figures.windowDays == null
						? terms.completeDays(observedDays, count(observedDays))
						: t.evidence.seenValue(
								count(observedDays),
								terms.completeDays(figures.windowDays, count(figures.windowDays)),
							),
		};
	}

	const unranked = $derived(
		ranking.state === 'none' || ranking.state === 'ranked' ? ranking.unranked : null,
	);
	// The published rows below the rule start at the first ten, like the ranking.
	let unrankedAll = $state(false);
	const unrankedShown = $derived(
		unranked == null ? [] : unranked.rows.slice(0, unrankedAll ? undefined : defaultCap),
	);
	const unrankedToggle = $derived.by(() => {
		if (unranked == null || unranked.rows.length <= defaultCap) return null;
		return unrankedAll
			? {
					label: t.ranking.showFewer(kind, count(defaultCap)),
					onclick: () => (unrankedAll = false),
				}
			: {
					label: t.ranking.showAll(kind, count(unranked.rows.length)),
					onclick: () => (unrankedAll = true),
				};
	});
	const earlierRule = $derived(
		(ranking.state === 'none' || ranking.state === 'ranked') && ranking.earlierRule,
	);

	const methodVersion = $derived(source?.methodology_version?.trim() || null);
	const methodText = $derived(
		methodVersion ? t.evidence.method(methodVersion) : t.evidence.methodUnknown,
	);
	const generatedUtc = $derived(offenders.data?.generated_utc ?? null);
	const publishedOn = $derived(generatedUtc?.slice(0, 10) ?? null);
	const sentence = (text: string) =>
		locale === 'fr' ? text.charAt(0).toLowerCase() + text.slice(1) : text;

	/**
	 * A copied link reopens this record, not whichever one is latest then: it names the shown
	 * record's date (its period ends there) and the row cap that keeps the chosen row visible.
	 * The current file names no dates; the history resource resolves it to its latest retained
	 * day, which is what the navigator shows. Without retained history, no date is named.
	 */
	function sameViewUrl(row: OffenderRowView): string {
		const date = offenders.canonicalDate ?? dates?.to ?? offenders.selectedDate ?? null;
		const query = [
			kind === 'vehicle' ? 'kind=buses' : null,
			period === OFFENDER_GRAINS[0] ? null : `grain=${period}`,
			date ? `date=${date}` : null,
			worstN === DEFAULT_WORST_N ? null : `n=${worstN}`,
			`selected=${encodeURIComponent(row.ref)}`,
		]
			.filter((part) => part != null)
			.join('&');
		return new URL(localizeHref(`/repeat-offenders?${query}`, locale), page.url.origin).href;
	}
	function citation(row: OffenderRowView): string {
		const figures = ranked.find((item) => item.key === row.key)!.figures;
		return t.citation({
			provider: manifest?.display_name?.trim() || null,
			subject: row.label,
			lateDays: row.lateDaysText,
			period: range ? sentence(range) : null,
			readings: readingsText(figures),
			published:
				publishedOn && /^\d{4}-\d{2}-\d{2}$/.test(publishedOn)
					? sentence(formatDayRange(publishedOn, publishedOn, locale))
					: null,
			method: methodText,
			url: sameViewUrl(row),
		});
	}

	function selectRow(key: string): void {
		const row = shownRows.find((candidate) => candidate.key === key);
		if (!row) return;
		if (!wide && row.key === selected?.key && expanded) {
			expanded = false;
			return;
		}
		selectedRef = row.ref;
		expanded = true;
	}
	function selectKind(next: OffenderKind): void {
		if (next === kind) return;
		kind = next;
		selectedRef = null;
		expanded = false;
		unrankedAll = false;
	}
	function selectPeriod(next: string): void {
		if (next === view.grain) return;
		view.selectGrain(next);
		selectedRef = null;
		expanded = false;
		unrankedAll = false;
	}
	const kindSegments = $derived<GrainSegment<OffenderKind>[]>([
		{ key: 'trip', label: t.kind.trip },
		{ key: 'vehicle', label: t.kind.vehicle },
	]);

	const paneId = $props.id();
	let frameWidth = $state(0);
	// The container query below shows the side pane at 60rem; the buttons follow the same rule.
	const wide = $derived(
		frameWidth > 0 &&
			frameWidth >= 60 * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16),
	);

	const record = createRecordStamp(
		() => manifest,
		() => generatedUtc,
	);
	const articleMeta = $derived.by((): readonly ArticleMetaEntry[] => {
		const stamp = record.meta(locale);
		return stamp ? [stamp] : [];
	});
	const metricHref = $derived(
		`${localizeHref('/metrics', locale)}#${metricInfoFor('severe', locale).anchor}`,
	);
</script>

{#snippet historyControls()}
	{#key historyCorrection.revision}
		<HistoryNavigator
			mode="date"
			date={offenders.selectedDate ?? undefined}
			dateOptions={availableDates.map((date) => ({ date }))}
			previousDate={offenders.previousDate}
			nextDate={offenders.nextDate}
			coverageText={availableDates.length === 0
				? null
				: t.history.coverage(
						formatDateKey(availableDates[0], locale),
						formatDateKey(availableDates[availableDates.length - 1], locale),
					)}
			selectionText={offenders.selectedDate == null
				? null
				: t.history.selection(formatDateKey(offenders.selectedDate, locale))}
			announcement={historyCorrection.announcement}
			liveAnnouncement={false}
			{locale}
			labels={t.history.navigator}
			onDateChange={selectHistoryDate}
		/>
	{/key}
{/snippet}

{#snippet evidence(row: OffenderRowView, level: 2 | 3)}
	<OffenderEvidence
		{row}
		view={evidenceOf(row)}
		{kind}
		{level}
		period={periodText}
		method={methodText}
		link={sameViewUrl(row)}
		citation={citation(row)}
		copy={t}
		{locale}
		{gauge}
	/>
{/snippet}
{#snippet inlineEvidence(row: OffenderRowView)}
	{@render evidence(row, 3)}
{/snippet}

<DetailFrame class="repeat-offenders-detail">
	{#snippet header()}
		<ArticleHeader
			watermark={t.article.watermark}
			category={t.kicker}
			title={t.heading}
			highlight={t.article.tags[0]}
			backHref={localizeHref('/', locale)}
			backLabel={t.article.back}
			meta={articleMeta}
			metaPending={offenders.loading || !offenders.settled || record.pending}
			titleId="repeat-offenders-title"
		>
			{#snippet controls()}
				<SectionsToggle />
			{/snippet}
		</ArticleHeader>
	{/snippet}

	<p
		class="offenders-history-live sr-only"
		data-slot="history-page-announcement"
		role="status"
		aria-live="polite"
		aria-atomic="true"
	>
		{historyCorrection.announcement ?? ''}
	</p>
	<div
		class="offenders-page"
		data-slot="offenders-page"
		use:hold.measure
		style:min-height={hold.minHeight}
	>
		<p class="offenders-purpose">{t.purpose}</p>
		<!-- Controls stay usable while a record loads; the ranking below waits for history discovery. -->
		<section class="offenders-controls" aria-label={t.controls} data-slot="offenders-controls">
			<div class="offenders-pickers">
				<GrainPicker
					segments={kindSegments}
					value={kind}
					onSelect={(key) => selectKind(key as OffenderKind)}
					label={t.kind.label}
				/>
				<GrainPicker
					segments={view.segments}
					value={view.grain}
					onSelect={selectPeriod}
					label={t.period.label}
				/>
			</div>
			{#if gauge || hold.held || hasHistoryNavigator}
				<!-- The navigator's room is held by a gauge of its fullest shape until the record arrives. -->
				<div class="offenders-stack">
					{#if gauge || (hold.held && !hasHistoryNavigator)}
						<div class="offenders-gauge" aria-hidden="true" inert>
							<HistoryNavigator
								mode="date"
								dateOptions={GAUGE_PICKER}
								coverageText={gaugeDays.coverage}
								selectionText={gaugeDays.selection}
								liveAnnouncement={false}
								{locale}
								labels={t.history.navigator}
							/>
						</div>
					{/if}
					{#if hasHistoryNavigator}{@render historyControls()}{/if}
				</div>
			{/if}
		</section>
		{#if gauge}
			<div class="offenders-stack">
				<div class="offenders-gauge offenders-record" aria-hidden="true" inert>
					{@render body()}
				</div>
				<EdgeState
					variant="skeleton"
					lang={locale}
					layout={desktop.current ? 'desktop' : 'mobile'}
				/>
			</div>
		{:else}
			<ResourceBoundary resource={offenders} lang={locale}>
				{#if discovered}
					<div class="offenders-record">{@render body()}</div>
				{/if}
			</ResourceBoundary>
		{/if}
	</div>
</DetailFrame>

{#snippet body()}
	<div class="offenders-controls">
		<p class="offenders-period" data-slot="offenders-period">{periodText}</p>
		<p class="offenders-meta">{t.measure}</p>
	</div>

	<h2 class="offenders-finding" data-slot="offenders-finding">{finding}</h2>
	{#if earlierRule}
		<p class="offenders-meta" data-slot="offenders-earlier-rule">{t.earlierRule}</p>
	{/if}

	{#if ranking.state === 'ranked' && selected}
		<div class="offenders-workspace-frame" bind:clientWidth={frameWidth}>
			<div class="offenders-workspace">
				<RepeatOffendersSection
					heading={t.ranking.heading[kind]}
					count={countText}
					rows={shownRows}
					selected={selected.key}
					{wide}
					{expanded}
					{paneId}
					onSelect={selectRow}
					{toggle}
					evidence={inlineEvidence}
					copy={t}
				/>
				<aside
					id={paneId}
					class="offenders-evidence-pane"
					aria-label={t.evidence.heading}
					data-slot="offender-evidence-pane"
				>
					{@render evidence(selected, 2)}
				</aside>
			</div>
		</div>
	{/if}

	{#if unranked}
		<section
			class="offenders-exclusions"
			aria-labelledby="offenders-exclusions-heading"
			data-slot="offender-exclusions"
		>
			<h2 id="offenders-exclusions-heading" class="offenders-section-heading">
				{t.exclusions.heading[kind]}
			</h2>
			<p>{t.exclusions.rule}</p>
			<p class="offenders-meta">{t.evidence.scope[kind]}</p>
			<p class="offenders-meta" data-slot="offender-excluded-total">
				{t.exclusions.total[kind]}
			</p>
		</section>

		{#if unranked.rows.length > 0}
			<CollapsibleSection
				title={t.unranked.title}
				anchor={gauge ? undefined : 'repeat-offenders-unranked'}
				independent={gauge}
			>
				{#snippet summary()}
					<p class="offenders-meta" data-slot="offender-unranked-summary">
						{t.unranked.summary(
							kind,
							unranked.rows.length,
							count(unranked.rows.length),
							unranked.complete,
							unranked.rows.every(
								(row) =>
									row.reasons.length > 0 && row.reasons.every((reason) => isMeasured(reason)),
							),
						)}
					</p>
				{/snippet}
				<ul class="offenders-unranked" aria-label={t.unranked.label[kind]}>
					{#each unrankedShown as row (row.key)}
						{@const identity = offenderIdentity(row.entry, display.directory, t)}
						{@const href = lineHref(row.entry.route)}
						<li>
							<span class="offenders-unranked-name">
								{#if identity.number}<span class="offender-plate">{identity.number}</span>{/if}
								<!-- The gauge keeps the link's box, a 44 px target, with no destination. -->
								{#if href || gauge}
									<a {href} aria-label={identity.label}>{identity.primary}</a>
								{:else}
									<span>{identity.primary}</span>
								{/if}
							</span>
							{#if identity.lineName}
								<span class="offenders-meta">{identity.lineName}</span>
							{/if}
							<span class="offenders-unranked-figures">
								{lateDaysText(row.figures)} · {readingsText(row.figures)}
							</span>
							<span class="offenders-meta">
								{row.reasons.length === 0
									? t.unranked.unexplained
									: row.reasons.map((reason) => t.unranked.reasons[reason]).join(' ')}
							</span>
						</li>
					{/each}
				</ul>
				{#if unrankedToggle}
					<button
						type="button"
						class="offenders-toggle"
						data-slot="offender-unranked-all"
						onclick={unrankedToggle.onclick}
					>
						{unrankedToggle.label}
					</button>
				{/if}
			</CollapsibleSection>
		{:else}
			<p class="offenders-meta" data-slot="offender-unranked-summary">
				{t.unranked.none[kind]}
			</p>
		{/if}
	{/if}

	<CollapsibleSection
		title={t.method.title}
		anchor={gauge ? undefined : 'repeat-offenders-method'}
		independent={gauge}
	>
		{#snippet summary()}
			<p class="offenders-meta">{t.method.summary}</p>
		{/snippet}
		<div class="offenders-method">
			<p>{t.exclusions.rule}</p>
			<p>{t.method.order}</p>
			<p>{t.method.definition}</p>
			<p>{t.method.interval}</p>
			<p>{methodText}</p>
			<a href={metricHref}>{metricInfoCopy[locale].link}</a>
		</div>
	</CollapsibleSection>
{/snippet}

<style>
	/* Room for the ranking and its selected evidence side by side on desktop. */
	:global([data-slot='detail-shell'].repeat-offenders-detail) {
		--detail-center-max: var(--container-wide);
	}
	.offenders-page {
		display: grid;
		align-content: start;
		gap: 1.5rem;
		min-width: 0;
	}
	.offenders-page :global(p) {
		margin: 0;
	}
	.offenders-record {
		display: grid;
		gap: 1.5rem;
		min-width: 0;
	}
	/* A gauge and what it reserves room for share one cell; the taller one sets the height. */
	.offenders-stack {
		display: grid;
		align-items: start;
		min-width: 0;
	}
	.offenders-stack > :global(*) {
		grid-area: 1 / 1;
		min-width: 0;
	}
	.offenders-gauge {
		visibility: hidden;
	}
	.offenders-purpose {
		font-size: var(--text-detail-subheading-mobile);
		line-height: 1.5;
	}
	.offenders-controls {
		display: grid;
		gap: 0.5rem;
		min-width: 0;
	}
	.offenders-pickers {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem 1.25rem;
	}
	.offenders-period {
		font-weight: 600;
	}
	.offenders-meta {
		color: var(--muted-foreground);
		font-size: var(--text-small);
	}
	.offenders-finding {
		margin: 0;
		font-size: var(--text-heading);
		line-height: 1.3;
		overflow-wrap: anywhere;
	}
	.offenders-workspace-frame {
		container: offenders-workspace / inline-size;
		min-width: 0;
	}
	.offenders-workspace {
		display: grid;
		align-items: start;
		gap: 1.5rem;
	}
	.offenders-evidence-pane {
		display: none;
		padding: 1rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
	}
	.offenders-section-heading {
		margin: 0;
		font-size: var(--text-heading);
		line-height: 1.25;
	}
	.offenders-exclusions {
		display: grid;
		gap: 0.75rem;
		padding-top: 1.25rem;
		border-top: 1px solid var(--border);
	}
	.offenders-unranked {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.offenders-unranked li {
		display: grid;
		gap: 0.25rem;
		padding-block: 0.625rem;
		border-bottom: 1px solid var(--border);
		min-width: 0;
	}
	.offenders-unranked-name {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.5rem;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.offenders-unranked a {
		display: inline-flex;
		align-items: center;
		min-height: var(--size-tap-min);
		overflow-wrap: anywhere;
	}
	.offenders-unranked-figures {
		font-variant-numeric: tabular-nums;
	}
	.offender-plate {
		display: inline-flex;
		align-items: center;
		padding: 0 0.375rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
	}
	.offenders-toggle {
		min-height: var(--size-tap-min);
		margin-top: 0.75rem;
		padding: 0 0.875rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--foreground);
		font: inherit;
		font-size: var(--text-small);
		cursor: pointer;
	}
	.offenders-toggle:hover {
		border-color: var(--foreground);
	}
	.offenders-toggle:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}
	.offenders-method {
		display: grid;
		gap: 0.75rem;
	}
	.offenders-method a {
		display: inline-flex;
		align-items: center;
		justify-self: start;
		min-height: var(--size-tap-min);
	}
	@container offenders-workspace (min-width: 60rem) {
		.offenders-workspace {
			grid-template-columns: minmax(0, 7fr) minmax(0, 5fr);
		}
		.offenders-evidence-pane {
			display: block;
		}
	}
	@media (--desktop-min) {
		.offenders-purpose {
			font-size: var(--text-detail-subheading-desktop);
		}
	}
</style>
