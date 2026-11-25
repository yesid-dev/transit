<script lang="ts">
	import { RoutePlate } from '@yesid/ui/brand';
	import type { RecordTableRow } from './RecordDataTable.svelte';

	let { row, plates = false }: { row: RecordTableRow; plates?: boolean } = $props();
</script>

{#snippet contents()}
	{#if plates || row.plate}
		<span class="plate">
			{#if row.plate}<RoutePlate {...row.plate} />{/if}
		</span>
	{/if}
	<span class="name-label">{row.label}</span>
	{#if row.detail}<span class="detail text-muted-foreground">{row.detail}</span>{/if}
{/snippet}

{#if row.href}
	<a
		class="name-cell"
		class:with-plate={plates || row.plate}
		class:schedule-only={row.plate?.scheduleOnly}
		href={row.href}
	>
		{@render contents()}
	</a>
{:else}
	<div class="name-cell" class:with-plate={plates || row.plate}>{@render contents()}</div>
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
	.plate {
		grid-column: 1;
		grid-row: 1 / span 2;
		align-self: center;
	}
	.name-label,
	.detail {
		grid-column: -2;
		min-inline-size: 0;
		overflow-wrap: normal;
	}
	@container (inline-size <= 18rem) {
		.name-cell.with-plate {
			grid-template-columns: minmax(0, 1fr);
		}
		.name-cell.with-plate .plate {
			grid-row: 1;
		}
	}
	@container (28rem < inline-size <= 46rem) {
		.name-cell.with-plate:not(.schedule-only) {
			grid-template-columns: minmax(min-content, 1fr);
		}
		.name-cell.with-plate:not(.schedule-only) .plate {
			grid-row: 1;
		}
		.name-cell.with-plate:not(.schedule-only) :is(.name-label, .detail) {
			font-size: var(--text-caption);
		}
	}
	@media (max-width: 40rem) {
		.plate {
			grid-row: 1;
		}
		.detail {
			grid-column: 1 / -1;
		}
		.schedule-only {
			grid-template-columns: minmax(0, 1fr);
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
