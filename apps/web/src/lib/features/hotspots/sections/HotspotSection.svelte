<script lang="ts" module>
	/** One published ranking row, already named and formatted for the page's language. */
	export interface HotspotRowView {
		readonly key: string;
		readonly id: string;
		readonly position: number;
		/** "Position 1 of 173". */
		readonly positionText: string;
		/** The line number, shown as a plate; null for stops and lines without one. */
		readonly number: string | null;
		/** The full published name, never truncated. */
		readonly name: string | null;
		/** "Line" or "Stop", spoken before the identity. */
		readonly kindWord: string;
		/** The name as a screen reader hears it, with its kind. */
		readonly spoken: string;
		/** The finding's identity: "303, Bayshore / Carlingwood". */
		readonly identity: string;
		readonly share: string | null;
		readonly readingsText: string;
		/** The record for the same dates and provider; null for the loading gauge's rows. */
		readonly href: string | null;
		readonly stopId: string | null;
	}
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HotspotsCopy } from '../hotspots.copy';

	interface HotspotSectionProps {
		heading: string;
		count: string;
		rows: readonly HotspotRowView[];
		selected: string;
		/** True when the side pane shows the selection; rows then select instead of expanding. */
		wide: boolean;
		expanded: boolean;
		paneId: string;
		onSelect: (key: string) => void;
		toggle?: { label: string; onclick: () => void } | null;
		evidence: Snippet<[HotspotRowView]>;
		copy: HotspotsCopy;
	}
	let {
		heading,
		count,
		rows,
		selected,
		wide,
		expanded,
		paneId,
		onSelect,
		toggle = null,
		evidence,
		copy,
	}: HotspotSectionProps = $props();
	const uid = $props.id();
	/** One sentence a screen reader hears; it repeats every visible part in order. */
	const spoken = (row: HotspotRowView) =>
		[
			`${row.positionText}.`,
			`${row.spoken}.`,
			row.share == null
				? `${copy.ranking.lateUnknown}.`
				: `${row.share} ${copy.ranking.spokenMeasure}.`,
			`${row.readingsText}.`,
		].join(' ');
</script>

<section class="hotspot-ranking" aria-labelledby="{uid}-heading" data-slot="hotspot-section">
	<div class="hotspot-ranking-top">
		<h2 id="{uid}-heading" class="hotspot-ranking-heading">{heading}</h2>
		<p class="hotspot-ranking-count" data-slot="hotspot-count">{count}</p>
	</div>
	<p class="hotspot-ranking-note">{copy.ranking.order}</p>
	<p class="hotspot-ranking-hint">{copy.ranking.choose}</p>
	<ol class="hotspot-rows" aria-labelledby="{uid}-heading" data-slot="hotspot-rows">
		{#each rows as row (row.key)}
			{@const chosen = row.key === selected}
			{@const open = !wide && expanded && chosen}
			<li class="hotspot-row-item" data-selected={chosen}>
				<button
					type="button"
					class="hotspot-row"
					aria-expanded={wide ? undefined : open}
					aria-pressed={wide ? chosen : undefined}
					aria-controls={wide ? paneId : `${uid}-evidence-${row.key}`}
					onclick={() => onSelect(row.key)}
				>
					<span class="sr-only">{spoken(row)}</span>
					<span class="hotspot-row-visual" aria-hidden="true">
						<span class="hotspot-row-position">{row.position}</span>
						<span class="hotspot-row-identity">
							{#if row.number}<span class="hotspot-plate">{row.number}</span>{/if}
							{#if row.name}
								<span class="hotspot-row-name" data-slot="hotspot-row-name">{row.name}</span>
							{/if}
						</span>
						<span class="hotspot-row-figures">
							<span class="hotspot-row-share" data-slot="ranking-rate">
								{row.share ?? copy.ranking.lateUnknown}
							</span>
							<span class="hotspot-row-readings">{row.readingsText}</span>
						</span>
					</span>
				</button>
				<div
					id="{uid}-evidence-{row.key}"
					class="hotspot-row-evidence"
					data-slot="hotspot-row-evidence"
					hidden={!open}
				>
					{#if open}{@render evidence(row)}{/if}
				</div>
			</li>
		{/each}
	</ol>
	{#if toggle}
		<button
			type="button"
			class="hotspot-toggle"
			data-slot="hotspot-show-all"
			onclick={toggle.onclick}
		>
			{toggle.label}
		</button>
	{/if}
</section>

<style>
	.hotspot-ranking {
		display: grid;
		gap: 0.75rem;
		min-width: 0;
		padding: 1rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--card);
	}
	.hotspot-ranking p {
		margin: 0;
	}
	.hotspot-ranking-top {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.25rem 1rem;
	}
	.hotspot-ranking-heading {
		margin: 0;
		font-size: var(--text-heading);
		line-height: 1.25;
	}
	.hotspot-ranking-count,
	.hotspot-ranking-hint {
		color: var(--muted-foreground);
		font-size: var(--text-small);
	}
	.hotspot-rows {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.hotspot-row-item + .hotspot-row-item {
		border-top: 1px solid var(--border);
	}
	.hotspot-row {
		display: grid;
		grid-template-columns: 2ch minmax(0, 1fr);
		grid-template-areas:
			'position identity'
			'. figures';
		align-items: baseline;
		gap: 0.25rem 0.75rem;
		width: 100%;
		min-height: var(--size-tap-min);
		padding: 0.625rem 0.5rem;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: inherit;
		font: inherit;
		text-align: start;
		cursor: pointer;
	}
	.hotspot-row-item[data-selected='true'] > .hotspot-row {
		background: var(--muted);
	}
	.hotspot-row:hover {
		background: var(--muted);
	}
	.hotspot-row:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: -2px;
	}
	/* The visible parts place themselves in the row grid; the sentence above names the row. */
	.hotspot-row-visual {
		display: contents;
	}
	.hotspot-row-position {
		grid-area: position;
		color: var(--muted-foreground);
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
		text-align: end;
	}
	.hotspot-row-identity {
		grid-area: identity;
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.25rem 0.5rem;
		min-width: 0;
	}
	.hotspot-row-name {
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.hotspot-row-figures {
		grid-area: figures;
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.25rem 1rem;
		font-variant-numeric: tabular-nums;
	}
	.hotspot-row-share {
		font-weight: 600;
	}
	.hotspot-row-readings {
		color: var(--muted-foreground);
		font-size: var(--text-small);
	}
	.hotspot-row-evidence {
		padding: 0.5rem 0.5rem 1.25rem calc(2ch + 1.25rem);
	}
	.hotspot-row-evidence[hidden] {
		display: none;
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
	.hotspot-toggle {
		justify-self: start;
		min-height: var(--size-tap-min);
		padding: 0 0.875rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--foreground);
		font: inherit;
		font-size: var(--text-small);
		cursor: pointer;
	}
	.hotspot-toggle:hover {
		border-color: var(--foreground);
	}
	.hotspot-toggle:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}
	@container hotspots-workspace (min-width: 60rem) {
		.hotspot-row {
			grid-template-columns: 2ch minmax(0, 1fr) auto;
			grid-template-areas: 'position identity figures';
		}
		.hotspot-row-figures {
			justify-content: flex-end;
			text-align: end;
		}
		.hotspot-row-evidence {
			display: none;
		}
	}
</style>
