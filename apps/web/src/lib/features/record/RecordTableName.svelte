<script lang="ts">
	import { RoutePlate } from '@yesid/ui/brand';
	import type { RecordTableRow } from './RecordDataTable.svelte';

	let { row, plates = false }: { row: RecordTableRow; plates?: boolean } = $props();
</script>

<div class="name-cell">
	{#if plates || row.plate}
		<div class="plate">
			{#if row.plate}<RoutePlate code={row.plate} scheduleOnly={row.scheduleOnly} />{/if}
		</div>
	{/if}
	<div class="name-text">
		<a
			href={row.href}
			aria-label={row.plate && row.plate !== row.label ? row.plate + ' · ' + row.label : undefined}
			>{row.label}</a
		>
		{#if row.detail}<p class="text-muted-foreground">{row.detail}</p>{/if}
	</div>
</div>

<style>
	.name-cell {
		display: flex;
		flex-wrap: wrap;
		align-items: start;
		column-gap: var(--space-card-gap);
	}
	.plate {
		flex: 0 0 3.75em;
		margin-block-start: 0.5em;
	}
	.name-text {
		flex: 1 1 8ch;
		min-inline-size: 0;
		overflow-wrap: normal;
	}
	.name-text a {
		display: inline-flex;
		align-items: center;
		min-block-size: var(--size-tap-min);
		min-inline-size: min(var(--size-tap-min), 100%);
		color: var(--primary);
		text-decoration: underline;
	}
	.name-text p {
		margin: 0;
	}
	.name-text a:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}
</style>
