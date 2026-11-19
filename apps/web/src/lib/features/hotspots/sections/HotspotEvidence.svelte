<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import { transitTerms } from '#lib/i18n/transitTerms.copy.ts';
	import type { HotspotsCopy } from '../hotspots.copy';
	import type { HotspotRowView } from './HotspotSection.svelte';
	import CopyAction from './CopyAction.svelte';

	interface HotspotEvidenceProps {
		row: HotspotRowView;
		/** 2 in the side pane, 3 inside the ranking card. */
		level: 2 | 3;
		period: string;
		method: string;
		link: string;
		citation: string;
		copy: HotspotsCopy;
		locale: Locale;
	}
	let { row, level, period, method, link, citation, copy, locale }: HotspotEvidenceProps = $props();
	const action = $derived(transitTerms[locale].action);
</script>

<div class="hotspot-evidence" data-slot="hotspot-evidence">
	<svelte:element this={`h${level}`} class="hotspot-evidence-heading">
		{copy.evidence.heading}
	</svelte:element>
	<p class="hotspot-evidence-identity">
		{#if row.number}<span class="hotspot-plate">{row.number}</span>{/if}
		{#if row.name}<span>{row.name}</span>{/if}
	</p>
	{#if row.stopId}
		<p class="hotspot-evidence-meta">{copy.evidence.stopId(row.stopId)}</p>
	{/if}
	<p class="hotspot-evidence-meta">{row.positionText}</p>
	{#if row.share != null}
		<p class="hotspot-evidence-result">
			<span class="hotspot-evidence-figure">{row.share}</span>
			<span>{copy.evidence.observed}</span>
		</p>
	{:else}
		<p class="hotspot-evidence-result" data-slot="absent-value">{copy.ranking.lateUnknown}</p>
	{/if}
	<dl class="hotspot-evidence-proof">
		<div>
			<dt>{copy.evidence.included}</dt>
			<dd>{row.readingsText}</dd>
		</div>
		<div>
			<dt>{copy.evidence.period}</dt>
			<dd>{period}</dd>
		</div>
	</dl>
	<p class="hotspot-evidence-meta">{copy.evidence.unit}</p>
	<p>{copy.evidence.noComparison}</p>
	<p class="hotspot-evidence-meta" data-slot="hotspot-no-interval">{copy.evidence.noInterval}</p>
	<p class="hotspot-evidence-meta">{method}</p>
	<div class="hotspot-evidence-actions">
		<!-- The loading gauge keeps this action's room with no destination: its rows name no record. -->
		<a
			class="hotspot-evidence-open"
			href={row.href}
			aria-label="{action.openRecord}: {row.spoken}"
			data-slot="hotspot-record-link">{action.openRecord}</a
		>
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
	.hotspot-evidence {
		display: grid;
		gap: 0.75rem;
		min-width: 0;
	}
	.hotspot-evidence p {
		margin: 0;
	}
	.hotspot-evidence-heading {
		margin: 0;
		font-size: var(--text-heading);
		line-height: 1.25;
	}
	.hotspot-evidence-identity {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.5rem;
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.hotspot-evidence-meta {
		color: var(--muted-foreground);
		font-size: var(--text-small);
	}
	.hotspot-evidence-result {
		display: grid;
		gap: 0.25rem;
	}
	.hotspot-evidence-figure {
		font-size: var(--text-metric-value-desktop);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		line-height: 1.1;
	}
	.hotspot-evidence-proof {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr));
		gap: 0.75rem;
		margin: 0;
	}
	.hotspot-evidence-proof div {
		display: grid;
		gap: 0.25rem;
	}
	.hotspot-evidence-proof dt {
		color: var(--muted-foreground);
		font-size: var(--text-small);
	}
	.hotspot-evidence-proof dd {
		margin: 0;
		font-variant-numeric: tabular-nums;
	}
	.hotspot-evidence-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: 0.5rem;
	}
	.hotspot-evidence-open {
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
	.hotspot-evidence-open:hover {
		border-color: var(--foreground);
	}
	.hotspot-evidence-open:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}
	.hotspot-plate {
		display: inline-flex;
		align-items: center;
		padding: 0 0.375rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
	}
</style>
