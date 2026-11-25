<script lang="ts">
	import { RoutePlate } from '@yesid/ui/brand';
	import type { Snippet } from 'svelte';
	import type { RecordTableRow } from './RecordDataTable.svelte';

	let {
		row,
		plates,
		columnCount,
		inlinePlate = false,
		detailContent,
	}: {
		row: RecordTableRow;
		plates: boolean;
		columnCount: number;
		inlinePlate?: boolean;
		detailContent?: Snippet;
	} = $props();
	const hasTrack = $derived(plates || !!row.plate || !!row.leadingCode);
</script>

{#snippet contents()}
	{#if hasTrack}
		<span class="plate">
			{#if row.plate}<RoutePlate {...row.plate} class={inlinePlate ? 'min-w-0!' : undefined} />
			{:else if row.leadingCode}<span
					class="font-mono text-sm"
					class:outlined={row.leadingCode.outline}>{row.leadingCode.text}</span
				>{/if}
		</span>
	{/if}
	<span class="name-label">{row.label}</span>
	{#if detailContent || row.detail}
		<span class="detail text-muted-foreground">
			{#if detailContent}{@render detailContent()}{:else}{row.detail}{/if}
		</span>
	{/if}
{/snippet}

{#if row.href}
	<a
		class="name-cell"
		class:with-plate={hasTrack}
		class:inline-plate={inlinePlate}
		class:schedule-only={row.plate?.scheduleOnly}
		data-many-columns={columnCount > 2 || undefined}
		href={row.href}
	>
		{@render contents()}
	</a>
{:else}
	<div
		class="name-cell"
		class:with-plate={hasTrack}
		class:inline-plate={inlinePlate}
		data-many-columns={columnCount > 2 || undefined}
	>
		{@render contents()}
	</div>
{/if}

<style>
	.name-cell {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		align-content: center;
		column-gap: calc(var(--space-card-gap) / 2);
	}
	.with-plate {
		grid-template-columns: 3.75em minmax(0, 1fr);
	}
	.with-plate:not([data-many-columns]) {
		grid-template-columns: minmax(min-content, min(3.75em, 31%)) minmax(0, 1fr);
	}
	.plate {
		grid-column: 1;
		grid-row: 1 / span 2;
		align-self: center;
	}
	.name-cell:not([data-many-columns]) .plate {
		align-self: start;
		white-space: nowrap;
	}
	.outlined {
		display: inline-block;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding-inline: 0.25em;
	}
	.name-label,
	.detail {
		grid-column: -2;
		min-inline-size: 0;
		overflow-wrap: normal;
	}
	.name-cell:not([data-many-columns]) .detail {
		font-size: var(--text-small);
		font-weight: 400;
		line-height: 1.35;
	}
	@container (inline-size <= 18rem) {
		.name-cell.with-plate[data-many-columns] {
			grid-template-columns: minmax(0, 1fr);
		}
		.name-cell.with-plate[data-many-columns] .plate {
			grid-row: 1;
		}
	}
	@container (28rem < inline-size <= 46rem) {
		.name-cell.with-plate[data-many-columns]:not(.schedule-only) {
			grid-template-columns: minmax(min-content, 1fr);
		}
		.name-cell.with-plate[data-many-columns]:not(.schedule-only) .plate {
			grid-row: 1;
		}
		.name-cell.with-plate[data-many-columns]:not(.schedule-only) :is(.name-label, .detail) {
			font-size: var(--text-caption);
		}
	}
	@media (max-width: 40rem) {
		.name-cell[data-many-columns] .plate {
			grid-row: 1;
		}
		.name-cell[data-many-columns] .detail {
			grid-column: 1 / -1;
		}
		.schedule-only[data-many-columns] {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	.name-cell.with-plate.inline-plate {
		grid-template-columns: max-content minmax(0, 1fr);
		column-gap: 0.5em;
	}
	.name-cell.with-plate.inline-plate .plate {
		grid-row: 1 / span 2;
		align-self: start;
	}
	@media (max-width: 40rem) {
		.name-cell.with-plate.inline-plate {
			column-gap: 0.25em;
		}
		.name-cell.with-plate.inline-plate .name-label {
			font-size: var(--text-caption);
			letter-spacing: var(--tracking-tight);
		}
	}
	a.name-cell {
		min-block-size: var(--size-tap-min);
		min-inline-size: min(var(--size-tap-min), 100%);
	}
	a .name-label {
		color: var(--primary);
		text-decoration: underline;
	}
	a.name-cell:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}
</style>
