<script lang="ts">
	import { getLocalizeHref, type Locale } from '#lib/i18n/index.ts';
	import { stopNameFallback } from '#lib/site/absence.ts';
	import { fmtNumber } from '#lib/utils/index.ts';
	import { fmtLocalePct } from '#lib/utils/format.ts';
	import type { WeakStop } from '#lib/v1/index.ts';
	import CollapsibleSection from './CollapsibleSection.svelte';
	import { selectStopDelays, type CutScope } from '../selectors/evidence';
	import { scopeDates } from '../recordDates';
	import type { ReliabilityCopy } from '../reliability.copy';

	interface Section4WorstStopsProps {
		stops: readonly WeakStop[];
		/** Which days the published stop figures cover. */
		scope: CutScope;
		locale: Locale;
		copy: ReliabilityCopy;
	}
	let { stops, scope, locale, copy }: Section4WorstStopsProps = $props();

	const FIRST = 5;
	const localizeHref = getLocalizeHref();
	const t = $derived(copy.evidence.stops);
	const e = $derived(copy.evidence);
	const rows = $derived(scope.kind === 'none' ? [] : selectStopDelays(stops));
	let showAll = $state(false);
	const visible = $derived(showAll ? rows : rows.slice(0, FIRST));
	const pct = (value: number) => fmtLocalePct(value, locale)!;
	const count = (value: number) => fmtNumber(value, { locale, rounding: 'round' })!;
	const name = (row: { id: string; name: string | null }) =>
		row.name ?? stopNameFallback(row.id, locale);
	const dates = $derived(scopeDates(scope, locale, e.history));
	const summary = $derived(
		rows[0] ? t.summary(name(rows[0]), pct(rows[0].percent)) : e.summaryAbsent,
	);
	const listId = 'line-stop-delays';
</script>

<CollapsibleSection dataSection="worst-stops" title={copy.sections.worstStops.label} {summary}>
	{#if rows.length > 0}
		<div class="evidence-body" data-slot="stop-delays" data-total={rows.length}>
			<p class="evidence-lead">
				{t.lead}
				{#if dates}{e.scope(dates)}{/if}
			</p>
			<p class="evidence-note">{t.order}</p>
			<ol class="stop-list" id={listId} aria-label={copy.sections.worstStops.label}>
				{#each visible as row, index (row.id)}
					<li class="stop-row" data-slot="stop-delay-row">
						<span class="stop-row__pos" aria-hidden="true">{index + 1}</span>
						<a class="stop-row__name" href={localizeHref(`/stop/${row.id}`, locale)}>{name(row)}</a>
						<span class="stop-row__meta">
							<span class="stop-row__value" data-slot="stop-delay-value"
								>{pct(row.percent)}<span class="sr-only">{t.valueNote}</span></span
							>
							<span class="stop-row__readings" data-slot="stop-delay-readings">
								{row.readings == null
									? t.readingsAbsent
									: e.readings(count(row.readings), row.readings)}
							</span>
						</span>
					</li>
				{/each}
			</ol>
			{#if rows.length > FIRST}
				<button
					type="button"
					class="evidence-toggle"
					data-slot="stop-delays-toggle"
					aria-expanded={showAll}
					aria-controls={listId}
					onclick={() => (showAll = !showAll)}
				>
					{showAll ? t.showFewer : t.showAll(count(rows.length))}
				</button>
			{/if}
		</div>
	{:else}
		<p class="evidence-body" data-slot="worst-stops-empty">
			<span class="evidence-absent" data-slot="absent-value"
				>{scope.kind === 'none' && scope.range ? t.absentRange : e.notPublished}</span
			>
		</p>
	{/if}
</CollapsibleSection>

<style>
	.stop-list {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.stop-row {
		display: grid;
		grid-template-columns: 1.5rem minmax(0, 1fr);
		column-gap: 0.75rem;
		align-items: baseline;
		padding-block: 0.25rem;
		border-block-end: 1px solid var(--border-subtle);
	}
	.stop-row__pos {
		color: var(--muted-foreground);
		font-variant-numeric: tabular-nums;
	}
	/* Full public names wrap; the link keeps a 44 px target. */
	.stop-row__name {
		display: inline-flex;
		align-items: center;
		min-block-size: var(--size-tap-min);
		min-width: 0;
		overflow-wrap: anywhere;
		text-wrap: pretty;
	}
	.stop-row__meta {
		grid-column: 2;
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1rem;
		padding-block-end: 0.5rem;
		font-variant-numeric: tabular-nums;
	}
	.stop-row__value {
		font-weight: 600;
	}
	.stop-row__readings {
		color: var(--muted-foreground);
		font-size: var(--text-small);
	}
	@container line-evidence (min-width: 36rem) {
		.stop-row {
			grid-template-columns: 1.5rem minmax(0, 1fr) auto;
		}
		.stop-row__meta {
			grid-column: 3;
			justify-content: end;
			padding-block-end: 0;
		}
	}
</style>
