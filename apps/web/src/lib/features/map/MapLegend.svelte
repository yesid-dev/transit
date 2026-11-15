<script lang="ts">
	import {
		OCCUPANCY_GLYPH,
		STATUS_GLYPH,
		occupancyVar,
		statusVar,
	} from '#lib/components/dataviz/tokens.ts';
	import type { Locale } from '#lib/i18n/index.ts';
	import MarkerGlyph from './MarkerGlyph.svelte';
	import { copy } from './map.copy';
	import { mapLegend, type LegendColourBy, type LegendMark } from './mapLegend';

	interface Props {
		locale: Locale;
		/** What the map colours buses by; the colour group explains only that. */
		colourBy: LegendColourBy;
		/** The map's own cutoff for the "no recent position" mark, in seconds. */
		staleCutoffS: number;
		/** Repeats the sentence under the map title where the title block has no room for it. */
		lead?: boolean;
	}

	let { locale, colourBy, staleCutoffS, lead = false }: Props = $props();
	const t = $derived(copy[locale]);
	const legend = $derived(mapLegend(locale, { colourBy, staleCutoffS }));

	// The same tables that draw the markers give each row its colour and badge shape.
	function colourOf(mark: LegendMark): string | undefined {
		if (mark.kind === 'status') return statusVar(mark.code);
		if (mark.kind === 'occupancy') return occupancyVar(mark.code);
		return undefined;
	}
	function glyphOf(mark: LegendMark): string | undefined {
		if (mark.kind === 'status') return STATUS_GLYPH[mark.code];
		if (mark.kind === 'occupancy') return OCCUPANCY_GLYPH[mark.code];
		return undefined;
	}
	function entryOf(mark: LegendMark): string {
		return mark.kind === 'stale' ? 'not-reporting' : mark.kind;
	}
</script>

{#if lead}<p class="mf-legend-lead" data-slot="map-legend-lead">{t.headingLead}</p>{/if}

<ul class="mf-legend" aria-label={t.legend.title} data-slot="map-legend" data-colour-by={colourBy}>
	{#each legend.groups as group (group.id)}
		<li class="mf-legend-group" data-legend-heading={group.id}>{group.heading}</li>
		{#each group.rows as row (row.id)}
			{@const colour = colourOf(row.mark)}
			{@const glyph = glyphOf(row.mark)}
			<li
				class="mf-legend-entry"
				data-legend-group={group.id}
				data-legend-entry={entryOf(row.mark)}
				data-status={row.mark.kind === 'status' ? row.mark.code : undefined}
				data-occupancy={row.mark.kind === 'occupancy' ? row.mark.code : undefined}
			>
				<span
					class="mf-legend-mark"
					class:mf-legend-stop={row.mark.kind === 'stop'}
					class:mf-legend-silent={row.mark.kind === 'stale'}
					style:color={colour}
					aria-hidden="true"
				>
					{#if row.mark.kind === 'status' || row.mark.kind === 'occupancy'}
						<MarkerGlyph kind="bus" />
					{:else if row.mark.kind === 'stop'}
						<MarkerGlyph kind="stop" />
					{:else if row.mark.kind === 'heading'}
						<svg viewBox="0 0 26 26" role="presentation">
							<path d="M13 5 19 13.5 13 10.6 7 13.5Z" fill="currentColor" />
							<circle cx="13" cy="19" r="2.5" fill="currentColor" opacity="0.45" />
						</svg>
					{:else}!{/if}
				</span>
				<span class="mf-legend-text" data-slot="map-legend-label">
					<span class="mf-legend-label">{row.label}</span>
					{#if row.definition}<span class="mf-legend-def">{row.definition}</span>{/if}
				</span>
				{#if glyph}<span class="mf-legend-glyph" aria-hidden="true">{glyph}</span>{/if}
			</li>
		{/each}
	{/each}
</ul>
<p class="mf-legend-note">{legend.note}</p>

<style>
	.mf-legend-lead {
		margin: 0 0 calc(var(--spacing) * 3);
		font-size: var(--text-caption);
		line-height: 1.4;
		color: var(--muted-foreground);
	}
	.mf-legend {
		margin: 0;
		padding: 0;
		list-style: none;
		font-family: var(--font-body);
		font-size: var(--text-caption);
		line-height: 1.4;
		color: var(--foreground);
	}
	/* One list, three tracks on every row: mark, words, badge shape. */
	.mf-legend-entry {
		display: grid;
		grid-template-columns: calc(var(--spacing) * 5) minmax(0, 1fr) calc(var(--spacing) * 4);
		align-items: start;
		gap: calc(var(--spacing) * 2);
		padding-block: calc(var(--spacing) * 0.75);
	}
	.mf-legend-group {
		margin-top: calc(var(--spacing) * 2);
		padding-top: calc(var(--spacing) * 2);
		padding-bottom: calc(var(--spacing) * 0.5);
		border-top: 1px solid var(--border-hairline);
		font-weight: 600;
	}
	.mf-legend-group:first-child {
		margin-top: 0;
		padding-top: 0;
		border-top: 0;
	}
	.mf-legend-mark {
		display: inline-grid;
		place-items: center;
		justify-self: center;
		width: calc(var(--spacing) * 4);
		height: 1.4em;
		color: var(--foreground);
		--marker-glyph-cut: var(--card);
	}
	.mf-legend-mark :global(svg) {
		display: block;
		width: 100%;
		height: calc(var(--spacing) * 4);
	}
	.mf-legend-silent {
		align-self: start;
		height: calc(var(--spacing) * 4);
		margin-top: 0.2em;
		font-weight: 800;
		line-height: 1;
		color: var(--background);
		background: var(--foreground);
		border-radius: var(--radius-sm);
	}
	.mf-legend-stop {
		color: var(--map-stop-fill);
	}
	.mf-legend-text {
		display: grid;
		min-width: 0;
	}
	.mf-legend-label {
		font-weight: 500;
	}
	.mf-legend-def {
		color: var(--muted-foreground);
		text-wrap: pretty;
	}
	.mf-legend-glyph {
		text-align: center;
	}
	.mf-legend-note {
		margin: calc(var(--spacing) * 3) 0 0;
		font-family: var(--font-body);
		font-size: var(--text-micro);
		line-height: 1.4;
		color: var(--muted-foreground);
	}
</style>
