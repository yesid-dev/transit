<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import { ExplainedMetricCard, RankedRow } from '#lib/components/dataviz/index.ts';
	import { SectionLabel, SectionHeading } from '@yesid/ui/brand';
	import type { StateCutsVM } from '../selectors/stateCuts';
	import { copy } from '../receipt.copy';

	interface SectionStateCutsProps {
		state: StateCutsVM;
		heading: string;
		completenessLabel: string;
		explainer: string;
		standDown: string;
		splitLabel: string;
		locale: Locale;
		headingLevel?: 2 | 3;
	}
	let {
		state,
		heading,
		completenessLabel,
		explainer,
		standDown,
		splitLabel,
		locale,
		headingLevel = 2,
	}: SectionStateCutsProps = $props();
</script>

<section class="receipt-states" data-slot="receipt-state-cuts" aria-label={heading}>
	<SectionHeading level={headingLevel} overline={heading} />

	<div class="receipt-states-hero" data-slot="receipt-completeness">
		<ExplainedMetricCard
			label={completenessLabel}
			value={state.completenessDisplay}
			explanation={explainer}
			note={state.completenessDisplay == null ? standDown : undefined}
			absentReason="no-observations"
			{locale}
			size="lg"
		/>
	</div>

	<div class="receipt-states-split" data-slot="receipt-state-split">
		<SectionLabel text={splitLabel} variant="metric" />
		{#if state.mismatch}
			<p>{copy[locale].stateCuts.mismatch}</p>
		{:else if state.basis != null && state.scheduled != null}
			<p>{copy[locale].stateCuts.basis(state.basis, state.scheduled, state.beyond)}</p>
		{/if}
		<div class="receipt-states-list" role="list" aria-label={splitLabel}>
			{#each state.rows as row (row.key)}
				<RankedRow
					rank={0}
					showRank={false}
					title={row.label}
					severity={row.severity}
					value={row.value}
					domain={row.domain}
					unit="%"
					display={row.display}
					absentReason="no-observations"
					{locale}
				/>
			{/each}
		</div>
	</div>
</section>

<style>
	.receipt-states {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
	}
	.receipt-states-hero {
		max-width: 24rem;
	}
	.receipt-states-split {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.receipt-states-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
</style>
