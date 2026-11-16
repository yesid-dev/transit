<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { page } from '$app/state';
	import { getV1Runtime } from '#lib/v1/runtime.ts';
	import { getV1Context } from '#lib/v1/boot.ts';
	import { getPublishedReliabilityIndex } from '#lib/v1/repositories/historic.ts';
	import { getRoutesIndex } from '#lib/v1/repositories/static.ts';
	import { getProvenance } from '#lib/v1/repositories/provenance.ts';
	import { createResource } from '#lib/v1/resource.svelte.ts';
	import { createReliabilityLoader } from '#lib/v1/reliabilitySnapshot.svelte.ts';
	import { routeHasNoLiveData } from '#lib/v1/providers.ts';
	import { reliabilityBadgeCopy, verdictCopy } from '#lib/v1/verdict.copy.ts';
	import { intl, getLocale, getLocalizeHref } from '#lib/i18n/index.ts';
	import { mapHrefFor } from '#lib/nav/index.ts';
	import { desktop } from '@yesid/ui/state';
	import { ListingFrame } from '@yesid/ui/layout';
	import { FilterGroup, FilterSection, SearchInput } from '@yesid/ui/brand';
	import { Card } from '@yesid/ui/card';
	import { StateNotice } from '@yesid/ui/feedback';
	import {
		EntityList,
		EntityResultRow,
		ReliabilityBadge,
		ResourceBoundary,
	} from '#lib/components/surface/index.ts';
	import type { ReliabilitySnapshot } from '#lib/v1/reliabilitySnapshot.svelte.ts';
	import { foldSearchText, tokenMatchScore } from '#lib/search/normalize.ts';
	import { routeModeHint, routeModeKey } from '#lib/search/stopMode.ts';
	import { currentMirrorUrl, mirrorSearchParams } from '#lib/site/urlMirror.ts';
	import { fmtLocalePct } from '#lib/utils/format.ts';
	import { formatDateKey } from '#lib/utils/time.ts';
	import type { RouteIndexEntry } from '#lib/v1/index.ts';
	import { createDirectoryComparison } from './directoryEvidence';
	import {
		comparisonEvidence,
		comparisonRows,
		DIRECTORY_PAGE_SIZE,
		directoryLineHref,
		directoryProviderHref,
		directoryScheduleHref,
		directorySearchParams,
		nextPageSize,
		ordinaryEvidence,
		parseDirectoryState,
		problemAssessment,
		type DirectoryEvidence,
		type DirectoryRow,
		type DirectoryState,
	} from './directoryState';
	import { formatRecordDates } from './reliability/recordDates';
	import {
		csvHref,
		DISPLAYED_CSV_FILENAME,
		directoryCsv,
		selectedRecordCsv,
		selectedRecordFilename,
		type DirectoryCsvRow,
	} from './directoryCsv';
	import LinesDirectoryPreview from './LinesDirectoryPreview.svelte';
	import { indexCopy } from './lines.copy';

	const locale = getLocale();
	const t = $derived(indexCopy[locale]);
	const verdicts = $derived(verdictCopy[locale]);
	const badgeCopy = $derived(reliabilityBadgeCopy[locale]);
	const localizeHref = getLocalizeHref();
	const runtime = getV1Runtime();
	const v1 = getV1Context();
	const providerId = $derived(v1.manifest.provider);
	const providerName = $derived(
		v1.provider?.labels[locale]?.operator ??
			v1.manifest.short_name?.trim() ??
			v1.manifest.display_name ??
			providerId,
	);

	onMount(() => runtime.clock.subscribe());

	const published = createResource((signal) => getPublishedReliabilityIndex({ signal }));
	const timeZone = $derived(v1.manifest.tz ?? 'UTC');
	const comparison = $derived(
		createDirectoryComparison(published.data, timeZone)(runtime.clock.serverNow),
	);
	const routes = createResource(() => getRoutesIndex());
	// Read once: a provider's declared capability stays unknown until its provenance actually loads.
	const provenance = createResource(() => getProvenance());
	const gaps = $derived(provenance.data ? (provenance.data.gaps ?? null) : undefined);

	const reliability = createReliabilityLoader('route', verdictCopy[locale]);
	const observeReliability = reliability.reliability;
	/** A compared row's figure comes from the index entry, so its badge carries no file snapshot. */
	const NO_SNAPSHOT: ReliabilitySnapshot = {
		phase: 'idle',
		otpPct: null,
		verdict: null,
		series: [],
		kind: 'route',
	};

	let view = $state<DirectoryState>(parseDirectoryState(new URLSearchParams(page.url.search)));
	let notice = $state<'comparison' | 'problem' | null>(null);
	const previewId = $props.id();
	const previewHeadingId = `directory-preview-${previewId}`;

	$effect(() => {
		mirrorSearchParams(directorySearchParams(view));
	});

	function apply(patch: Partial<DirectoryState>): void {
		view = { ...view, ...patch };
	}

	/** Any narrowing resets the list to its first page, as the count then changes. */
	function narrow(patch: Partial<DirectoryState>): void {
		view = { ...view, ...patch, shown: DIRECTORY_PAGE_SIZE };
	}

	function chooseOrder(key: string | null): void {
		if (key !== 'worst') {
			notice = null;
			apply({ order: 'number' });
			return;
		}
		if (!comparison) return;
		// Comparison ranks one published week; the latest-record problem filter answers another
		// question, so choosing one clears the other rather than mixing periods silently.
		notice = 'comparison';
		narrow({ order: 'comparison', status: 'all' });
	}

	function chooseStatus(key: string | null): void {
		if (key !== 'problem') {
			notice = null;
			apply({ status: 'all' });
			return;
		}
		notice = 'problem';
		narrow({ status: 'problem', order: 'number' });
	}

	function chooseMode(key: string | null): void {
		narrow({ mode: key ?? 'all' });
	}

	function clearFilters(): void {
		notice = null;
		narrow({ query: '', mode: 'all', status: 'all' });
	}

	const collator = intl.collator(locale, { numeric: true, sensitivity: 'base' });
	const numberFmt = intl.number(locale);
	const allLines = $derived(routes.data?.routes ?? []);
	const numberOrder = $derived([...allLines].sort((a, b) => collator.compare(a.short, b.short)));

	const modeItems = $derived.by(() => {
		const counts: Record<string, { label: string; count: number }> = {};
		for (const line of allLines) {
			const key = routeModeKey(line.type);
			const label = routeModeHint(line.type).tag;
			if (key == null || label == null) continue;
			const current = counts[key];
			counts[key] = { label, count: (current?.count ?? 0) + 1 };
		}
		return Object.entries(counts)
			.sort((a, b) => collator.compare(a[1].label, b[1].label))
			.map(([key, item]) => ({ key, label: `${item.label} (${numberFmt.format(item.count)})` }));
	});

	const matches = $derived.by<RouteIndexEntry[]>(() => {
		const q = foldSearchText(view.query);
		return numberOrder.filter((line) => {
			if (view.mode !== 'all' && routeModeKey(line.type) !== view.mode) return false;
			return !q || tokenMatchScore([line.id, line.short, line.long], q) != null;
		});
	});

	const rows = $derived.by<DirectoryRow[]>(() => {
		const current = comparison;
		if (view.order === 'comparison' && current) return comparisonRows(matches, current);
		return matches.map((line) => ({ line, entry: null, ranked: false }));
	});

	function noLiveFor(line: RouteIndexEntry): boolean {
		const known = gaps;
		// An unknown or failed capability is never a claim of absent live data.
		if (known == null) return false;
		return routeHasNoLiveData(providerId, line.type, known);
	}

	function evidenceFor(row: DirectoryRow): DirectoryEvidence {
		if (row.entry && comparison) return comparisonEvidence(row.entry, comparison);
		return ordinaryEvidence(reliability.get(row.line.id), {
			noLive: noLiveFor(row.line),
			lineId: row.line.id,
			copy: verdicts,
		});
	}

	const visibleRows = $derived(
		view.status === 'problem'
			? rows.filter((row) => problemAssessment(evidenceFor(row)) !== 'clean')
			: rows,
	);

	// The problem filter asks about every matching line, through the loader's own queue and
	// four-request ceiling, so its answer is complete rather than viewport-shaped.
	$effect(() => {
		if (view.status !== 'problem') return;
		for (const row of rows) reliability.request(row.line.id);
	});

	const summary = $derived.by(() => {
		let problems = 0;
		let pending = 0;
		let failed = 0;
		for (const row of rows) {
			const assessment = problemAssessment(evidenceFor(row));
			if (assessment === 'problem') problems += 1;
			else if (assessment === 'pending') pending += 1;
			else if (assessment === 'failed') failed += 1;
		}
		return { problems, pending, failed, matching: rows.length };
	});

	const shownRows = $derived(visibleRows.slice(0, view.shown));
	const moreCount = $derived(nextPageSize(view.shown, visibleRows.length));
	const countText = $derived(
		view.status === 'problem'
			? t.problemCounts(
					numberFmt.format(summary.problems),
					numberFmt.format(summary.matching),
					numberFmt.format(summary.pending),
					numberFmt.format(summary.failed),
				)
			: t.counts(
					numberFmt.format(shownRows.length),
					numberFmt.format(matches.length),
					numberFmt.format(allLines.length),
				),
	);

	const noMatch = $derived(routes.settled && visibleRows.length === 0);
	const noMatchTitle = $derived(
		view.status === 'problem'
			? t.problemNone
			: view.query
				? t.noMatch(view.query)
				: t.noMatchFilters,
	);

	const rangeRequested = $derived(
		page.url.searchParams.has('from') || page.url.searchParams.has('to'),
	);
	const noticeText = $derived(
		notice === 'problem' ? t.problemNotice : notice === 'comparison' ? t.comparisonNotice : null,
	);
	/** The compared week, named once at page level; rows carry their own dates. */
	const comparisonContext = $derived.by(() => {
		if (view.order !== 'comparison' || !comparison) return null;
		const dates = formatRecordDates(comparison.period.from, comparison.period.to, locale);
		return dates ? t.comparisonContext(dates) : null;
	});

	const selectedRow = $derived.by<DirectoryRow | null>(() => {
		if (view.line) return rows.find((row) => row.line.id === view.line) ?? null;
		return desktop.current ? (shownRows[0] ?? null) : null;
	});

	// The previewed line is read even when its row is below the fold: one request, through the
	// same loader queue, so a shared `line=` link never opens an empty preview.
	$effect(() => {
		const row = selectedRow;
		if (row) reliability.request(row.line.id);
	});

	const csvOptions = (csvRows: readonly DirectoryCsvRow[]) => ({
		rows: csvRows,
		providerId,
		providerName,
		locale,
		// Downloads name the application's own origin so their links stay usable away from the page.
		origin: page.url.origin,
		modeTag: (line: RouteIndexEntry) => routeModeHint(line.type).tag,
		recordHref: (row: DirectoryCsvRow) => lineRecordHref(row.line, row.evidence),
	});
	const selectedCsvRow = $derived.by<DirectoryCsvRow | null>(() =>
		selectedRow
			? { line: selectedRow.line, ranked: selectedRow.ranked, evidence: evidenceFor(selectedRow) }
			: null,
	);
	// The displayed file is the list itself: same rows, same order, same evidence.
	const displayedCsv = $derived.by(() => {
		const csvRows = shownRows.map((row) => ({
			line: row.line,
			ranked: row.ranked,
			evidence: evidenceFor(row),
		}));
		return csvRows.length > 0 ? csvHref(directoryCsv(csvOptions(csvRows))) : null;
	});
	const recordCsv = $derived.by(() => {
		if (!selectedCsvRow) return null;
		const body = selectedRecordCsv(csvOptions([selectedCsvRow]));
		const filename = selectedRecordFilename(selectedCsvRow);
		return body && filename ? { href: csvHref(body), filename } : null;
	});

	function lineRecordHref(line: RouteIndexEntry, evidence: DirectoryEvidence): string {
		return directoryLineHref({
			base: currentMirrorUrl(),
			path: localizeHref(`/lines/${encodeURIComponent(line.id)}`, locale),
			providerId,
			from: evidence.from,
			to: evidence.to,
			days: evidence.days,
		});
	}

	function lineScheduleHref(line: RouteIndexEntry): string {
		return directoryScheduleHref({
			base: currentMirrorUrl(),
			path: localizeHref(`/lines/${encodeURIComponent(line.id)}`, locale),
			providerId,
		});
	}

	function lineMapHref(line: RouteIndexEntry): string {
		return directoryProviderHref({
			base: currentMirrorUrl(),
			path: mapHrefFor({ route: line.id }, locale),
			providerId,
		});
	}

	const pctText = (evidence: DirectoryEvidence) =>
		evidence.percent == null ? null : fmtLocalePct(evidence.percent, locale, { rounding: 'round' });
	const datesText = (evidence: DirectoryEvidence) =>
		evidence.from && evidence.to ? formatRecordDates(evidence.from, evidence.to, locale) : null;
	const weekLabel = (evidence: DirectoryEvidence) =>
		evidence.to ? badgeCopy.weekTo(formatDateKey(evidence.to, locale)) : badgeCopy.week;

	/** The figure's accessible name: the number, what it measures and the exact days it covers. */
	function figureLabel(evidence: DirectoryEvidence): string {
		const pct = pctText(evidence);
		const dates = datesText(evidence);
		if (!pct) return '';
		return dates ? `${pct}, ${t.measureLabel}, ${dates}` : `${pct}, ${t.measureLabel}`;
	}

	function hedgeStatus(evidence: DirectoryEvidence): 'absent' | 'tentative' {
		if (evidence.state === 'low-sample') return 'absent';
		return evidence.verdictStatus === 'tentative' ? 'tentative' : 'absent';
	}

	function stateText(evidence: DirectoryEvidence): string {
		switch (evidence.state) {
			case 'low-sample':
				return t.lowSample;
			case 'not-published':
				return t.notPublished;
			case 'no-live':
				return t.noLive;
			case 'failed':
				return t.failed;
			case 'loading':
				// A row below the fold is not being read yet; only an actual read says it is checking.
				return t.loading;
			case 'unranked':
				return evidence.excluded ? t.unranked[evidence.excluded] : t.unrankedNoEntry;
			case 'uncertain':
				return t.uncertain;
			default:
				return evidence.hedge ?? t.uncertain;
		}
	}

	/** Whether this row's read is actually in flight, so "checking" is never claimed from the fold. */
	function checking(line: RouteIndexEntry): boolean {
		return reliability.get(line.id).phase === 'loading';
	}

	/** The row's one line of context: its complete days and the readings behind the figure. */
	function detailText(row: DirectoryRow, evidence: DirectoryEvidence): string {
		if (evidence.state === 'figure' || evidence.state === 'uncertain') {
			const readings =
				evidence.readings == null ? null : t.basis(numberFmt.format(evidence.readings));
			return [datesText(evidence), readings ?? t.basisUnknown].filter(Boolean).join(' · ');
		}
		if (evidence.state === 'low-sample')
			return [t.lowSample, datesText(evidence)].filter(Boolean).join(' · ');
		if (evidence.state === 'loading') return checking(row.line) ? t.loading : '';
		return stateText(evidence);
	}

	/** A status cell only exists when it can show a number, a hedge or a retry. */
	const hasStatus = (evidence: DirectoryEvidence) =>
		evidence.state === 'figure' ||
		evidence.state === 'uncertain' ||
		evidence.state === 'low-sample' ||
		evidence.state === 'failed';

	let previewOrigin: { button: HTMLElement; scrollY: number } | null = null;
	async function openPreview(line: RouteIndexEntry, event: MouseEvent): Promise<void> {
		previewOrigin = { button: event.currentTarget as HTMLElement, scrollY: window.scrollY };
		apply({ line: line.id });
		await tick();
		const heading = document.getElementById(previewHeadingId);
		heading?.focus({ preventScroll: true });
		heading?.scrollIntoView({ block: 'start' });
	}

	async function backToResults(): Promise<void> {
		const origin = previewOrigin;
		apply({ line: null });
		await tick();
		origin?.button.focus({ preventScroll: true });
		if (origin) window.scrollTo({ top: origin.scrollY });
	}
</script>

{#snippet listingSearch()}
	<SearchInput
		label={t.filterLabel}
		placeholder={t.filterPlaceholder}
		testId="lines-filter-input"
		value={view.query}
		oninput={(event) => narrow({ query: (event.currentTarget as HTMLInputElement).value })}
	/>
{/snippet}

{#snippet listingFilters()}
	<FilterSection>
		{#if comparison}
			<FilterGroup
				label={t.orderLabel}
				items={[{ key: 'worst', label: t.orderComparison }]}
				activeKey={view.order === 'comparison' ? 'worst' : null}
				allLabel={t.orderNumber}
				allowDeselect={false}
				collapsible
				testIdPrefix="lines-sort"
				onSelect={chooseOrder}
			/>
		{:else}
			<div class="directory-order-note">
				<span class="label-section text-sm font-semibold">{t.orderLabel}</span>
				<p class="directory-order-current">{t.orderNumber}</p>
				<button
					type="button"
					data-testid="lines-sort-worst"
					disabled
					aria-describedby={`${previewId}-order`}
				>
					{t.orderComparison}
				</button>
				<p id={`${previewId}-order`} class="directory-note">{t.comparisonUnavailable}</p>
			</div>
		{/if}
	</FilterSection>

	<FilterSection>
		<FilterGroup
			label={t.statusFilterLabel}
			items={[{ key: 'problem', label: t.statusProblem }]}
			activeKey={view.status === 'problem' ? 'problem' : null}
			allLabel={t.statusAll}
			allowDeselect={false}
			collapsible
			testIdPrefix="lines-status"
			onSelect={chooseStatus}
		/>
	</FilterSection>

	<FilterSection>
		<FilterGroup
			label={t.modeFilterLabel}
			items={modeItems}
			activeKey={view.mode === 'all' ? null : view.mode}
			allLabel={t.modeAll}
			allowDeselect={false}
			collapsible
			testIdPrefix="lines-mode"
			onSelect={chooseMode}
		/>
	</FilterSection>
{/snippet}

<ResourceBoundary resource={routes} lang={locale} isEmpty={(d) => d.routes.length === 0}>
	<ListingFrame
		presentation="reading"
		rule="dimension"
		heading={t.heading}
		subtitle={providerName}
		description={t.lede}
		filterLabel={t.controlsLabel}
		resultCountText={countText}
		search={listingSearch}
		filters={listingFilters}
	>
		<div class="directory" data-slot="lines-directory">
			<div class="directory-results">
				<div class="directory-toolbar">
					<p class="directory-count" data-slot="directory-counts">{countText}</p>
					{#if displayedCsv}
						<a
							class="directory-download"
							data-slot="directory-csv"
							download={DISPLAYED_CSV_FILENAME}
							href={displayedCsv}
						>
							{t.downloadDisplayed}
						</a>
					{/if}
				</div>
				{#if noticeText}
					<p class="directory-notice" role="status" aria-live="polite">{noticeText}</p>
				{/if}
				{#if comparisonContext}
					<p class="directory-context" data-slot="directory-comparison">
						{comparisonContext}
					</p>
				{/if}
				{#if rangeRequested}
					<p class="directory-notice" data-slot="directory-range-notice">
						{t.rangeUnsupported}
					</p>
				{/if}

				{#if noMatch}
					<StateNotice title={noMatchTitle} presentation="silo" role="status" aria-live="polite">
						{#snippet action()}
							<button type="button" class="directory-clear tap-press" onclick={clearFilters}>
								{t.clearFilters}
							</button>
						{/snippet}
					</StateNotice>
				{:else}
					<Card textSize="inherit" class="directory-card">
						<EntityList
							items={shownRows}
							key={(row) => row.line.id}
							max={shownRows.length}
							aria-label={t.listLabel}
							class="directory-list"
						>
							{#snippet row(row)}
								{@const evidence = evidenceFor(row)}
								{@const hint = routeModeHint(row.line.type)}
								{@const statusAvailable = hasStatus(evidence)}
								<div
									class="directory-row"
									class:is-selected={selectedRow?.line.id === row.line.id}
									use:observeReliability={row.line.id}
								>
									{#snippet status()}
										{#if evidence.source === 'published_weekly_index' && row.entry}
											<ReliabilityBadge
												published={row.entry}
												snapshot={NO_SNAPSHOT}
												named
												{locale}
											/>
										{:else if evidence.state === 'figure'}
											<span
												class="directory-figure"
												data-slot="reliability-badge"
												data-status={evidence.verdictStatus ?? undefined}
												role="img"
												aria-label={figureLabel(evidence)}
												title={figureLabel(evidence)}
											>
												<span class="directory-figure-pct"
													>{pctText(evidence)} {badgeCopy.share}</span
												>
												<span>{weekLabel(evidence)}</span>
											</span>
										{:else if evidence.state === 'uncertain' || evidence.state === 'low-sample'}
											<span
												class="directory-figure"
												data-slot="reliability-hedge"
												data-status={hedgeStatus(evidence)}
												role="img"
												aria-label={evidence.hedge ?? stateText(evidence)}
												title={evidence.hedge ?? stateText(evidence)}
											>
												<span>
													{evidence.state === 'low-sample'
														? badgeCopy.compactHedges.absent
														: badgeCopy.compactHedges.tentative}
												</span>
											</span>
										{:else if evidence.state === 'failed'}
											<button
												type="button"
												class="directory-retry tap-press"
												onclick={() => reliability.retry(row.line.id)}
											>
												{t.retry}
											</button>
										{/if}
									{/snippet}
									{#snippet action()}
										<button
											type="button"
											class="directory-preview tap-press"
											aria-label={t.previewLine(row.line.short)}
											onclick={(event) => openPreview(row.line, event)}
										>
											{t.previewAction}
										</button>
									{/snippet}
									<EntityResultRow status={statusAvailable ? status : undefined} {action}>
										<div class="directory-identity">
											<a
												class="directory-name readable-name"
												href={lineRecordHref(row.line, evidence)}
												aria-label={[t.lineHeading(row.line.short), row.line.long]
													.filter(Boolean)
													.join(', ')}
											>
												<span class="directory-number">{row.line.short}</span>
												{#if row.line.long}
													<span class="directory-long">{t.routeName(row.line.long)}</span>
												{/if}
											</a>
											<p class="directory-detail">
												{#if hint.tag}<span class="directory-mode">{hint.tag} · </span>{/if}
												<span>{detailText(row, evidence)}</span>
												{#if evidence.older}<span class="directory-older"> · {t.older}</span>{/if}
											</p>
										</div>
									</EntityResultRow>
								</div>
							{/snippet}
						</EntityList>

						{#if moreCount > 0}
							<div class="directory-more">
								<button
									type="button"
									class="directory-more-button tap-press"
									onclick={() => apply({ shown: view.shown + DIRECTORY_PAGE_SIZE })}
								>
									{moreCount === 1 ? t.showMoreLast : t.showMore(numberFmt.format(moreCount))}
								</button>
							</div>
						{/if}
					</Card>
				{/if}
			</div>

			{#if selectedRow}
				{@const evidence = evidenceFor(selectedRow)}
				<div class="directory-preview-column">
					<LinesDirectoryPreview
						line={selectedRow.line}
						{evidence}
						{locale}
						{providerName}
						recordHref={lineRecordHref(selectedRow.line, evidence)}
						scheduleHref={lineScheduleHref(selectedRow.line)}
						mapHref={lineMapHref(selectedRow.line)}
						{recordCsv}
						headingId={previewHeadingId}
						checking={checking(selectedRow.line)}
						showBack={!desktop.current}
						onBack={backToResults}
					/>
				</div>
			{/if}
		</div>
	</ListingFrame>
</ResourceBoundary>

<style>
	.directory {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1.5rem;
		align-items: start;
		min-width: 0;
	}
	.directory-results {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-width: 0;
	}
	.directory-count,
	.directory-note,
	.directory-notice,
	.directory-context {
		margin: 0;
		font-size: var(--text-small);
		line-height: 1.45;
		color: var(--muted-foreground);
	}
	.directory-context {
		font-variant-numeric: tabular-nums;
	}
	.directory-count {
		font-variant-numeric: tabular-nums;
	}
	.directory-toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem 1rem;
	}
	.directory-download {
		display: inline-flex;
		min-height: var(--size-tap-min);
		align-items: center;
		padding: 0.375rem 0.75rem;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-pill);
		color: var(--foreground);
		font-size: var(--text-small);
		text-decoration: none;
	}
	.directory-download:hover,
	.directory-download:focus-visible {
		border-color: var(--primary);
		color: var(--primary);
	}
	.directory-notice {
		padding: 0.5rem 0.75rem;
		border-left: 2px solid var(--border-brand);
		overflow-wrap: break-word;
	}
	:global(.card-surface.directory-card) {
		padding: 0;
		gap: 0;
	}
	.directory-order-note {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 0;
	}
	.directory-order-note p {
		margin: 0;
	}
	.directory-order-current {
		font-size: var(--text-small);
		color: var(--foreground);
	}
	.directory-order-note button {
		min-height: var(--size-tap-min);
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-md);
		background: var(--card);
		color: var(--muted-foreground);
		font: inherit;
		text-align: left;
	}
	.directory-order-note button:disabled {
		opacity: 0.7;
		cursor: not-allowed;
	}
	.directory-row {
		/* The row is its own container: the shared row's narrow layout stacks the evidence and the
		   action under the name instead of squeezing the name into a column. */
		container: entity-card / inline-size;
		min-width: 0;
	}
	.directory-row.is-selected {
		/* One selection accent: the plate of the line whose record the preview shows. */
		box-shadow: inset 2px 0 0 var(--accent-text);
	}
	.directory-identity {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
	}
	.directory-name {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.5rem;
		min-height: var(--size-tap-min);
		align-content: center;
		color: var(--foreground);
		font-size: var(--text-body);
		font-weight: 600;
		text-decoration: none;
		overflow-wrap: anywhere;
	}
	.directory-name:hover .directory-number,
	.directory-name:focus-visible .directory-number {
		text-decoration: underline;
	}
	.directory-number {
		font-family: var(--font-mono);
		font-size: var(--text-subheading);
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		color: var(--accent-text);
		white-space: nowrap;
	}
	.directory-long {
		font-weight: 500;
		overflow-wrap: anywhere;
	}
	.directory-detail {
		display: block;
		margin: 0;
		min-height: 1.45em;
		font-size: var(--text-small);
		line-height: 1.45;
		color: var(--muted-foreground);
		overflow-wrap: break-word;
	}
	.directory-mode,
	.directory-older {
		font-family: var(--font-mono);
		font-size: var(--text-micro);
		text-transform: uppercase;
		letter-spacing: var(--tracking-eyebrow);
	}
	.directory-mode {
		color: var(--accent-text);
	}
	.directory-older {
		padding: 0.0625rem 0.375rem;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-sm);
	}
	.directory-figure {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		font-family: var(--font-mono);
		font-size: var(--text-caption);
		line-height: 1.3;
		font-variant-numeric: tabular-nums;
		text-align: right;
		color: var(--foreground);
		overflow-wrap: break-word;
	}
	.directory-figure-pct {
		font-size: var(--text-body);
		font-weight: 700;
	}
	.directory-preview,
	.directory-retry,
	.directory-more-button,
	.directory-clear {
		display: inline-flex;
		min-height: var(--size-tap-min);
		align-items: center;
		padding: 0.5rem 0.875rem;
		border: 1px solid var(--border-brand);
		border-radius: var(--radius-pill);
		background: var(--surface-1);
		color: var(--foreground);
		font: inherit;
		font-size: var(--text-control);
		font-weight: 600;
		cursor: pointer;
	}
	.directory-more-button,
	.directory-clear {
		padding: 0.5rem 1rem;
	}
	.directory-preview:hover,
	.directory-preview:focus-visible,
	.directory-retry:hover,
	.directory-retry:focus-visible,
	.directory-more-button:hover,
	.directory-more-button:focus-visible,
	.directory-clear:hover,
	.directory-clear:focus-visible {
		border-color: var(--primary);
		color: var(--primary);
	}
	.directory-more,
	.directory-clear {
		justify-content: center;
	}
	.directory-more {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		padding: 0.75rem;
	}
	@media (max-width: 30rem) {
		/* Two reserved lines keep a row's height steady while its evidence arrives, so nothing
		   below it jumps when a record lands. */
		.directory-detail {
			min-height: 2.9em;
		}
	}
	@media (min-width: 1024px) {
		.directory {
			grid-template-columns: minmax(0, 58fr) minmax(0, 42fr);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.directory-preview,
		.directory-retry,
		.directory-more-button,
		.directory-clear {
			transition: none;
		}
	}
</style>
