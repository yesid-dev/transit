<script lang="ts" module>
	/** One published trip or bus, already named and formatted for the page's language. */
	export interface OffenderRowView {
		readonly key: string;
		/** The `selected` URL value: the published id and its line. */
		readonly ref: string;
		readonly position: number;
		/** "Position 1 of 120". */
		readonly positionText: string;
		/** The line number, shown as a plate. */
		readonly number: string | null;
		/** What is ranked: "07:42 toward Monk", "Trip 302181944", "Bus 4672". */
		readonly primary: string;
		/** The line's full name, never truncated. */
		readonly lineName: string | null;
		/** One sentence naming the row. */
		readonly label: string;
		readonly lateDaysText: string;
		readonly averageDelayText: string;
		/** The line's record for the same dates and provider. */
		readonly href: string | null;
	}
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { RepeatOffendersCopy } from '../repeatOffenders.copy';

	interface RepeatOffendersSectionProps {
		heading: string;
		count: string;
		rows: readonly OffenderRowView[];
		selected: string;
		/** True when the side pane shows the selection; rows then select instead of expanding. */
		wide: boolean;
		expanded: boolean;
		paneId: string;
		onSelect: (key: string) => void;
		toggle?: { label: string; onclick: () => void } | null;
		evidence: Snippet<[OffenderRowView]>;
		copy: RepeatOffendersCopy;
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
	}: RepeatOffendersSectionProps = $props();
	const uid = $props.id();
	/** One sentence a screen reader hears; it repeats every visible part in order. */
	const spoken = (row: OffenderRowView) =>
		[
			`${row.positionText}.`,
			`${row.label}.`,
			`${row.lateDaysText}.`,
			`${row.averageDelayText}.`,
		].join(' ');
</script>

<section class="offender-ranking" aria-labelledby="{uid}-heading" data-slot="offender-section">
	<div class="offender-ranking-top">
		<h2 id="{uid}-heading" class="offender-ranking-heading">{heading}</h2>
		<p class="offender-ranking-meta" data-slot="offender-count">{count}</p>
	</div>
	<p class="offender-ranking-note">{copy.ranking.order}</p>
	<p class="offender-ranking-meta">{copy.ranking.choose}</p>
	<ol class="offender-rows" aria-labelledby="{uid}-heading" data-slot="offender-rows">
		{#each rows as row (row.key)}
			{@const chosen = row.key === selected}
			{@const open = !wide && expanded && chosen}
			<li class="offender-row-item" data-selected={chosen}>
				<button
					type="button"
					class="offender-row"
					aria-expanded={wide ? undefined : open}
					aria-pressed={wide ? chosen : undefined}
					aria-controls={wide ? paneId : `${uid}-evidence-${row.key}`}
					onclick={() => onSelect(row.key)}
				>
					<span class="sr-only">{spoken(row)}</span>
					<span class="offender-row-visual" aria-hidden="true">
						<span class="offender-row-position">{row.position}</span>
						<span class="offender-row-identity">
							<span class="offender-row-primary">
								{#if row.number}<span class="offender-plate">{row.number}</span>{/if}
								<span data-slot="offender-row-name">{row.primary}</span>
							</span>
							{#if row.lineName}
								<span class="offender-row-line" data-slot="offender-row-line">{row.lineName}</span>
							{/if}
						</span>
						<span class="offender-row-figures">
							<span class="offender-row-late" data-slot="ranking-rate">{row.lateDaysText}</span>
							<span class="offender-row-delay">{row.averageDelayText}</span>
						</span>
					</span>
				</button>
				<div
					id="{uid}-evidence-{row.key}"
					class="offender-row-evidence"
					data-slot="offender-row-evidence"
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
			class="offender-toggle"
			data-slot="offender-show-all"
			onclick={toggle.onclick}
		>
			{toggle.label}
		</button>
	{/if}
</section>

<style>
	.offender-ranking {
		display: grid;
		gap: 0.75rem;
		min-width: 0;
		padding: 1rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--card);
	}
	.offender-ranking p {
		margin: 0;
	}
	.offender-ranking-top {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.25rem 1rem;
	}
	.offender-ranking-heading {
		margin: 0;
		font-size: var(--text-heading);
		line-height: 1.25;
	}
	.offender-ranking-meta {
		color: var(--muted-foreground);
		font-size: var(--text-small);
	}
	.offender-rows {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.offender-row-item + .offender-row-item {
		border-top: 1px solid var(--border);
	}
	.offender-row {
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
	.offender-row-item[data-selected='true'] > .offender-row,
	.offender-row:hover {
		background: var(--muted);
	}
	.offender-row:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: -2px;
	}
	/* The visible parts place themselves in the row grid; the sentence above names the row. */
	.offender-row-visual {
		display: contents;
	}
	.offender-row-position {
		grid-area: position;
		color: var(--muted-foreground);
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
		text-align: end;
	}
	.offender-row-identity {
		grid-area: identity;
		display: grid;
		gap: 0.125rem;
		min-width: 0;
	}
	.offender-row-primary {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.25rem 0.5rem;
		min-width: 0;
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.offender-row-line {
		color: var(--muted-foreground);
		font-size: var(--text-small);
		overflow-wrap: anywhere;
	}
	.offender-row-figures {
		grid-area: figures;
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.25rem 1rem;
		font-variant-numeric: tabular-nums;
	}
	.offender-row-delay {
		color: var(--muted-foreground);
		font-size: var(--text-small);
	}
	.offender-row-evidence {
		padding: 0.5rem 0.5rem 1.25rem calc(2ch + 1.25rem);
	}
	.offender-row-evidence[hidden] {
		display: none;
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
	.offender-toggle {
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
	.offender-toggle:hover {
		border-color: var(--foreground);
	}
	.offender-toggle:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}
	@container offenders-workspace (min-width: 60rem) {
		.offender-row {
			grid-template-columns: 2ch minmax(0, 1fr) auto;
			grid-template-areas: 'position identity figures';
		}
		.offender-row-figures {
			flex-direction: column;
			align-items: flex-end;
			gap: 0.125rem;
			text-align: end;
		}
		.offender-row-evidence {
			display: none;
		}
	}
</style>
