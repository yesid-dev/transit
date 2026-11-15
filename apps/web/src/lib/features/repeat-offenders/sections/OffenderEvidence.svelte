<script lang="ts" module>
	/** The selected row's evidence, formatted for the page's language. */
	export interface OffenderEvidenceView {
		/** "4 of 6", or null when either day count is not published. */
		readonly figure: string | null;
		readonly figureText: string;
		readonly averageDelay: string;
		/** The late count, never the total in its place. */
		readonly lateReadings: string;
		/** The total, shown on its own only when the late count is not published. */
		readonly readings: string | null;
		readonly interval: string;
		readonly seen: string;
	}
</script>

<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import { transitTerms } from '#lib/i18n/transitTerms.copy.ts';
	import CopyAction from '#lib/features/hotspots/sections/CopyAction.svelte';
	import type { RepeatOffendersCopy } from '../repeatOffenders.copy';
	import type { OffenderRowView } from './RepeatOffendersSection.svelte';

	interface OffenderEvidenceProps {
		row: OffenderRowView;
		view: OffenderEvidenceView;
		kind: 'trip' | 'vehicle';
		/** 2 in the side pane, 3 inside the ranking card. */
		level: 2 | 3;
		period: string;
		method: string;
		link: string;
		citation: string;
		copy: RepeatOffendersCopy;
		locale: Locale;
	}
	let {
		row,
		view,
		kind,
		level,
		period,
		method,
		link,
		citation,
		copy,
		locale,
	}: OffenderEvidenceProps = $props();
	const action = $derived(transitTerms[locale].action);
</script>

<div class="offender-evidence" data-slot="offender-evidence">
	<svelte:element this={`h${level}`} class="offender-evidence-heading">
		{copy.evidence.heading}
	</svelte:element>
	<div class="offender-evidence-identity">
		<p class="offender-evidence-primary">
			{#if row.number}<span class="offender-plate">{row.number}</span>{/if}
			<span>{row.primary}</span>
		</p>
		{#if row.lineName}<p class="offender-evidence-meta">{row.lineName}</p>{/if}
	</div>
	<p class="offender-evidence-meta">{row.positionText}</p>
	{#if view.figure != null}
		<p class="offender-evidence-result">
			<span class="offender-evidence-figure" data-slot="offender-late-days">{view.figure}</span>
			<span>{view.figureText}</span>
		</p>
	{:else}
		<p class="offender-evidence-result" data-slot="absent-value">{view.figureText}</p>
	{/if}
	<dl class="offender-evidence-proof">
		<div>
			<dt>{copy.evidence.averageDelay}</dt>
			<dd>{view.averageDelay}</dd>
		</div>
		<div>
			<dt>{copy.evidence.lateReadings}</dt>
			<dd data-slot="offender-late-readings">{view.lateReadings}</dd>
		</div>
		{#if view.readings != null}
			<div>
				<dt>{copy.evidence.readings}</dt>
				<dd data-slot="offender-readings">{view.readings}</dd>
			</div>
		{/if}
		<div>
			<dt>{copy.evidence.interval}</dt>
			<dd data-slot="offender-interval">{view.interval}</dd>
		</div>
		<div>
			<dt>{copy.evidence.seen}</dt>
			<dd>{view.seen}</dd>
		</div>
		<div>
			<dt>{copy.evidence.period}</dt>
			<dd>{period}</dd>
		</div>
	</dl>
	<p data-slot="offender-scope">{copy.evidence.scope[kind]}</p>
	<p class="offender-evidence-meta">{copy.evidence.unit}</p>
	<p class="offender-evidence-meta">{copy.evidence.noComparison}</p>
	<p class="offender-evidence-meta">{method}</p>
	<div class="offender-evidence-actions">
		{#if row.href}
			<a
				class="offender-evidence-open"
				href={row.href}
				aria-label="{copy.evidence.openLine}: {copy.departure(row.number ?? '', null, null)}"
				data-slot="offender-record-link">{copy.evidence.openLine}</a
			>
		{/if}
		<CopyAction
			text={link}
			label={action.copyLink}
			done={copy.share.linkCopied}
			fallback={copy.share.fallback}
			fallbackLabel={copy.share.text}
		/>
		<CopyAction
			text={citation}
			label={action.citeRecord}
			done={copy.share.citationCopied}
			fallback={copy.share.fallback}
			fallbackLabel={copy.share.text}
		/>
	</div>
</div>

<style>
	.offender-evidence {
		display: grid;
		gap: 0.75rem;
		min-width: 0;
	}
	.offender-evidence p {
		margin: 0;
	}
	.offender-evidence-heading {
		margin: 0;
		font-size: var(--text-heading);
		line-height: 1.25;
	}
	.offender-evidence-identity {
		display: grid;
		gap: 0.125rem;
		min-width: 0;
	}
	.offender-evidence-primary {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.5rem;
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.offender-evidence-meta {
		color: var(--muted-foreground);
		font-size: var(--text-small);
		overflow-wrap: anywhere;
	}
	.offender-evidence-result {
		display: grid;
		gap: 0.25rem;
	}
	.offender-evidence-figure {
		font-size: var(--text-metric-value-desktop);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		line-height: 1.1;
	}
	.offender-evidence-proof {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr));
		gap: 0.75rem;
		margin: 0;
	}
	.offender-evidence-proof div {
		display: grid;
		gap: 0.25rem;
	}
	.offender-evidence-proof dt {
		color: var(--muted-foreground);
		font-size: var(--text-small);
	}
	.offender-evidence-proof dd {
		margin: 0;
		font-variant-numeric: tabular-nums;
	}
	.offender-evidence-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: 0.5rem;
	}
	.offender-evidence-open {
		display: inline-flex;
		align-items: center;
		min-height: var(--size-tap-min);
		padding: 0 0.875rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		color: var(--foreground);
		font-size: var(--text-small);
		text-decoration: none;
	}
	.offender-evidence-open:hover {
		border-color: var(--foreground);
	}
	.offender-evidence-open:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}
	.offender-plate {
		display: inline-flex;
		align-items: center;
		padding: 0 0.375rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
		font-weight: 400;
	}
</style>
