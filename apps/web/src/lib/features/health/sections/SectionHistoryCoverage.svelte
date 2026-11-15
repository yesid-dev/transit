<script lang="ts">
	import { Badge } from '@yesid/ui/badge';
	import { StateNotice } from '@yesid/ui/feedback';
	import { intl, type Locale } from '#lib/i18n/index.ts';
	import { AbsentValue } from '#lib/components/edge/index.ts';
	import { describeAbsence } from '#lib/site/absence.ts';
	import { formatDateKey } from '#lib/utils/time.ts';
	import type { HealthCopy } from '../health.copy';
	import type {
		HistoryCoverageFamilyKey,
		HistoryCoverageFamilyView,
		HistoryInventoryView,
	} from '../selectors/historyCoverage';

	interface SectionHistoryCoverageProps {
		rows: readonly HistoryCoverageFamilyView[];
		/** The history date list's own stamp; it dates every family below. */
		inventory: HistoryInventoryView | null;
		/** The last record was published with warnings or past a failed check. */
		recordWarning: boolean;
		copy: HealthCopy;
		locale: Locale;
	}

	let { rows, inventory, recordWarning, copy, locale }: SectionHistoryCoverageProps = $props();
	const t = $derived(copy.historyCoverage);
	const n = (value: number) => intl.number(locale).format(value);
	const evidenceId = $props.id();

	// Open on the first family whose days can be counted; the reader's choice wins afterwards.
	let chosen = $state<HistoryCoverageFamilyKey | null>(null);
	const selected = $derived(
		rows.find((row) => row.key === chosen) ??
			rows.find((row) => row.days != null) ??
			rows.find((row) => row.published) ??
			rows[0],
	);
	let panel = $state<HTMLElement | null>(null);

	function choose(key: HistoryCoverageFamilyKey) {
		chosen = key;
		// One column: the evidence sits under the list, so bring it into view when it is all below.
		if (panel && panel.getBoundingClientRect().top > window.innerHeight) {
			const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
			panel.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
		}
	}

	// Short dates only inside the year the date list was published; any other year is written out.
	const listYear = $derived(inventory?.publishedOn?.slice(0, 4) ?? null);
	function windowLabel(first: string, last: string, year = false): string {
		const withYear = year || first.slice(0, 4) !== listYear || last.slice(0, 4) !== listYear;
		return `${formatDateKey(first, locale, withYear)} – ${formatDateKey(last, locale, withYear)}`;
	}
</script>

{#snippet daysSummary(row: HistoryCoverageFamilyView)}
	{#if row.days?.withRecords != null}
		<span class="days-main"
			>{t.days.withRecords(n(row.days.withRecords), n(row.days.inWindow))}</span
		>
		<span class="days-note">
			{row.days.missing
				? t.days.missing(
						n(row.days.missing),
						row.days.missing,
						n(row.days.gapRuns ?? 0),
						row.days.gapRuns ?? 0,
					)
				: t.days.none}
		</span>
	{:else if row.days}
		<span class="days-main">{t.days.inWindow(n(row.days.inWindow), row.days.inWindow)}</span>
		<span class="days-note absent">{t.days.unknown}</span>
	{:else if row.state === 'unreadable-dates' || row.state === 'past-publication'}
		<span class="days-note absent">{t.days.unreadable}</span>
	{:else if row.state === 'announced-periods'}
		<span class="days-note absent">{t.days.alertsUncounted}</span>
	{/if}
{/snippet}

<!-- A gap list as published: its dates, explicitly none, or not published at all. -->
{#snippet gapList(gaps: HistoryCoverageFamilyView['gaps'])}
	{#if gaps == null}
		<span class="days-note absent">{t.days.unknown}</span>
	{:else if gaps.length === 0}
		<span class="days-note">{t.days.none}</span>
	{:else}
		<ul class="gap-list">
			{#each gaps as gap (`${gap.startDate}:${gap.endDate}:${gap.reason ?? ''}`)}
				<li>
					<span class="mono">{windowLabel(gap.startDate, gap.endDate)}</span>
					{#if gap.reason}<span class="gap-reason">{gap.reason}</span>{/if}
				</li>
			{/each}
		</ul>
	{/if}
{/snippet}

<!-- In the index rows the absence is a plain label: the row itself is the control. -->
{#snippet dates(row: HistoryCoverageFamilyView, year = false, disclosure = true)}
	{#if row.firstDate && row.lastDate}
		<span class="dates">{windowLabel(row.firstDate, row.lastDate, year)}</span>
	{:else}
		<AbsentValue
			variant="compact"
			reason={row.published ? 'no-retained-dates' : 'not-published'}
			{disclosure}
			{locale}
		/>
	{/if}
{/snippet}

<!-- A long identifier shows its first characters, like a short commit hash; the title has it all. -->
{#snippet fact(label: string, value: string | null, short = false)}
	<div class="fact">
		<dt>{label}</dt>
		<dd>
			{#if value && short && value.length > 12}<span class="mono" title={value}
					>{value.slice(0, 12)}…</span
				>{:else if value}<span class="mono">{value}</span>{:else}<span class="absent"
					>{t.evidence.notPublished}</span
				>{/if}
		</dd>
	</div>
{/snippet}

<div class="coverage" data-slot="history-coverage-section">
	<p class="coverage-note">{t.note}</p>
	<div class="coverage-grid">
		<div class="coverage-index">
			<div class="index-head" aria-hidden="true">
				<span>{t.columns.family}</span><span>{t.columns.window}</span><span>{t.columns.days}</span>
			</div>
			<ul aria-label={t.indexLabel}>
				{#each rows as row (row.key)}
					{@const pressed = row.key === selected?.key}
					<li
						class="family-row"
						data-family={row.key}
						data-state={row.state}
						data-selected={pressed}
					>
						<button
							type="button"
							class="family-select"
							aria-pressed={pressed}
							aria-controls={evidenceId}
							onclick={() => choose(row.key)}>{t.families[row.key]}</button
						>
						<span class="family-dates">{@render dates(row, false, false)}</span>
						<span class="family-days">{@render daysSummary(row)}</span>
					</li>
				{/each}
			</ul>
		</div>

		{#if selected}
			<section
				class="coverage-evidence"
				id={evidenceId}
				aria-label={t.evidence.region(t.families[selected.key])}
				bind:this={panel}
				data-family={selected.key}
			>
				<h3>{t.families[selected.key]}</h3>
				{#if !selected.published}
					{@const absence = describeAbsence('not-published', locale)}
					<StateNotice
						title={absence.label}
						body={t.evidence.absent}
						glyph="○"
						presentation="row"
					/>
				{:else}
					<dl class="facts">
						<div class="fact">
							<dt>
								{selected.state === 'announced-periods'
									? t.evidence.alertDatesLabel
									: t.evidence.datesLabel}
							</dt>
							<dd>{@render dates(selected, true)}</dd>
						</div>
						<div class="fact">
							<dt>{t.evidence.daysLabel}</dt>
							<dd class="days">
								{@render daysSummary(selected)}
								{#if selected.state === 'past-publication'}
									<span class="days-note">{t.days.pastPublication}</span>
								{:else if selected.state === 'announced-periods'}
									<span class="days-note">{t.days.alertsExplain}</span>
								{:else if !selected.days && selected.state !== 'unreadable-dates'}
									<AbsentValue variant="compact" reason="no-retained-dates" {locale} />
								{/if}
							</dd>
						</div>
						{#if selected.gaps?.length}
							<div class="fact">
								<dt>{t.evidence.missingLabel}</dt>
								<dd>{@render gapList(selected.gaps)}</dd>
							</div>
						{/if}
						{#if selected.selectionMode}
							<div class="fact">
								<dt>{t.evidence.browseLabel}</dt>
								<dd>{t.selection[selected.selectionMode]}</dd>
							</div>
						{/if}
					</dl>
					<div class="group">
						<h4>{t.evidence.measuresLabel}</h4>
						{#if selected.metrics.length === 0}
							<AbsentValue variant="compact" reason="no-metric-inventory" {locale} />
						{:else}
							<ul class="metric-list">
								{#each selected.metrics as metric (metric.key)}
									<li data-metric={metric.key} data-aggregation={metric.aggregation}>
										<span class="metric-head">
											<span class="metric-name">{t.metrics[metric.key]}</span>
											<Badge variant="tag">{t.aggregation[metric.aggregation]}</Badge>
										</span>
										{#if metric.firstDate && metric.lastDate}
											<span class="mono muted"
												>{windowLabel(metric.firstDate, metric.lastDate)}</span
											>
										{:else}
											<AbsentValue variant="compact" reason="no-retained-dates" {locale} />
										{/if}
										<!-- A measure keeps its own holes; the family's continuity says nothing about it. -->
										{@render gapList(metric.gaps)}
									</li>
								{/each}
							</ul>
						{/if}
					</div>
					{#if selected.currentOnlySections.length > 0}
						<div class="group" data-slot="current-only-limitations">
							<h4>{t.currentOnlySections}</h4>
							<p class="muted">{t.currentOnlyNote}</p>
							<ul class="current-only-list">
								{#each selected.currentOnlySections as section (section)}
									<li>{t.currentOnlySectionLabels[section] ?? section.replaceAll('_', ' ')}</li>
								{/each}
							</ul>
						</div>
					{/if}
				{/if}
				<div class="group">
					<h4>{t.evidence.sourceTitle}</h4>
					<dl class="facts">
						{@render fact(t.evidence.fingerprintLabel, selected.collectionGenerationId, true)}
						{@render fact(
							t.evidence.listPublishedLabel,
							inventory?.publishedOn ? formatDateKey(inventory.publishedOn, locale, true) : null,
						)}
						{@render fact(
							copy.envelope.generationIdLabel,
							inventory?.publishGenerationId ?? null,
							true,
						)}
						{@render fact(
							copy.envelope.methodologyVersionLabel,
							inventory?.methodologyVersion ?? null,
						)}
						{@render fact(t.evidence.nextUpdateLabel, null)}
						{#if recordWarning}
							<div class="fact">
								<dt>{t.evidence.warningsLabel}</dt>
								<dd>{t.evidence.warningsUnscoped}</dd>
							</div>
						{/if}
					</dl>
					{#if selected.collectionGenerationId}
						<p class="muted">{t.evidence.fingerprintExplain}</p>
					{/if}
				</div>
			</section>
		{/if}
	</div>
</div>

<style>
	.coverage {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		min-width: 0;
		container: health-coverage / inline-size;
	}
	.coverage-note {
		margin: 0;
		color: var(--muted-foreground);
		font-size: var(--text-detail-body-mobile);
		line-height: 1.8;
	}
	.coverage-grid {
		display: grid;
		gap: 1.5rem;
		min-width: 0;
	}
	.coverage-index ul,
	.gap-list,
	.metric-list,
	.current-only-list {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.coverage-index {
		min-width: 0;
		container: coverage-index / inline-size;
	}
	.index-head {
		display: none;
	}
	/* Two-line rows on narrow widths: the family and its dates, then its days. */
	.family-row {
		position: relative;
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		grid-template-areas:
			'name dates'
			'days days';
		gap: 0 1rem;
		align-items: center;
		padding: 0.25rem 0.75rem;
		border: 1px solid transparent;
		border-top-color: var(--border-subtle);
		border-radius: var(--radius-md);
	}
	.family-row:first-child {
		border-top-color: transparent;
	}
	.family-row[data-selected='true'] {
		border-color: var(--primary);
		background: color-mix(in srgb, var(--primary) 8%, transparent);
	}
	.family-row[data-selected='true'] + .family-row {
		border-top-color: transparent;
	}
	/* The control itself meets the 44 px target, not only the row overlay drawn from it. */
	.family-select {
		grid-area: name;
		justify-self: start;
		display: inline-flex;
		align-items: center;
		min-block-size: 2.75rem;
		min-inline-size: 2.75rem;
		padding: 0;
		border: 0;
		background: none;
		color: var(--foreground);
		font: inherit;
		font-weight: 600;
		text-align: start;
		cursor: pointer;
	}
	/* The whole row selects; the button stays the one control and keeps the focus ring. */
	.family-select::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: inherit;
	}
	.family-select:focus-visible {
		outline: none;
	}
	.family-row:has(.family-select:focus-visible) {
		outline: 2px solid var(--primary);
		outline-offset: 2px;
	}
	.family-row:hover .family-select {
		color: var(--primary);
	}
	.family-dates {
		grid-area: dates;
		justify-self: end;
		text-align: end;
	}
	.family-days {
		grid-area: days;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		padding-bottom: 0.5rem;
	}
	.family-days:empty {
		display: none;
	}
	.dates,
	.mono {
		font-family: var(--font-mono);
		font-size: var(--text-small);
		font-variant-numeric: tabular-nums;
		overflow-wrap: anywhere;
	}
	.days-main {
		font-size: var(--text-small);
		font-variant-numeric: tabular-nums;
		color: var(--foreground);
	}
	.days-note,
	.muted,
	.gap-reason {
		color: var(--muted-foreground);
		font-size: var(--text-small);
		line-height: 1.45;
	}
	.absent::before {
		content: '';
		display: inline-block;
		inline-size: 0.6rem;
		block-size: 0.6rem;
		margin-inline-end: 0.4rem;
		border: 1.5px solid currentColor;
		border-radius: 50%;
	}
	.absent {
		color: var(--muted-foreground);
		font-size: var(--text-small);
	}
	.coverage-evidence {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		min-width: 0;
		padding-top: 1.25rem;
		border-top: 1px solid var(--border-subtle);
	}
	.coverage-evidence h3 {
		margin: 0;
		font-size: var(--text-heading);
		font-weight: 600;
		line-height: 1.25;
	}
	.coverage-evidence h4 {
		margin: 0;
		font-size: var(--text-small);
		font-weight: 600;
		color: var(--foreground);
	}
	.group,
	.facts {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		min-width: 0;
		margin: 0;
	}
	.fact {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
	}
	.fact dt {
		color: var(--muted-foreground);
		font-size: var(--text-small);
	}
	.fact dd {
		margin: 0;
		min-width: 0;
		color: var(--foreground);
	}
	.fact dd.days {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}
	.gap-list,
	.metric-list {
		display: grid;
		gap: 0.5rem;
	}
	.gap-list li,
	.metric-list li {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
	}
	.metric-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.5rem;
	}
	.metric-name {
		font-weight: 600;
	}
	.current-only-list {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem 0.5rem;
	}
	.current-only-list li {
		padding: 0.15rem 0.45rem;
		border-radius: var(--radius-md);
		background: var(--muted);
		color: var(--secondary-foreground);
		font-size: var(--text-caption);
	}

	/* Aligned columns once a row can hold the family, its dates and its days on one line. */
	@container coverage-index (min-width: 30rem) {
		.index-head,
		.family-row {
			display: grid;
			grid-template-columns: minmax(7rem, 0.9fr) minmax(0, 1.1fr) minmax(0, 1.4fr);
			grid-template-areas: 'name dates days';
			gap: 1rem;
		}
		.index-head {
			padding: 0 0.75rem 0.5rem;
			color: var(--muted-foreground);
			font-size: var(--text-small);
		}
		.family-dates {
			justify-self: start;
			text-align: start;
		}
		.family-days:empty {
			display: flex;
		}
		.family-days {
			padding-block: 0.5rem;
		}
	}
	/* 8 + 4: the index beside the selected family. */
	@container health-coverage (min-width: 46rem) {
		.coverage-grid {
			grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
			align-items: start;
		}
		.coverage-evidence {
			padding-top: 0;
			padding-inline-start: 1.5rem;
			border-top: 0;
			border-inline-start: 1px solid var(--border-subtle);
		}
	}
	@media (--desktop-min) {
		.coverage-note {
			font-size: var(--text-detail-body-desktop);
			line-height: 1.9;
		}
	}
</style>
