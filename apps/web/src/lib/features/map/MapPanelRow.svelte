<script lang="ts">
	import { RoutePlate } from '@yesid/ui/brand';
	import type { Snippet } from 'svelte';

	let {
		code,
		routePlate = false,
		name,
		accessibleName,
		detail,
		href,
		onselect,
		value,
		vehicleId,
	}: {
		code?: string;
		routePlate?: boolean;
		name: string;
		accessibleName?: string;
		detail?: string | null;
		href?: string;
		onselect?: () => void;
		value: Snippet;
		vehicleId?: string;
	} = $props();

	function follow(event: MouseEvent) {
		if (!onselect || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
		event.preventDefault();
		onselect();
	}
</script>

<li
	class="panel-row"
	data-map-panel-row
	data-report-row={vehicleId ? '' : undefined}
	data-report-id={vehicleId}
>
	<span class="code" data-map-row-code>
		{#if code}
			{#if routePlate}<RoutePlate {code} />{:else}<span class="stop-code" title={code}>{code}</span
				>{/if}
		{/if}
	</span>
	{#if href}
		<a
			class="name text-primary underline"
			{href}
			aria-label={accessibleName}
			title={name}
			onclick={follow}
			data-map-row-name
			data-in-view-vehicle={vehicleId}>{name}</a
		>
	{:else}
		<button
			class="name text-primary underline"
			type="button"
			aria-label={accessibleName}
			title={name}
			onclick={onselect}
			data-map-row-name>{name}</button
		>
	{/if}
	<span class="value" data-map-row-value>{@render value()}</span>
	{#if detail}<small title={detail}>{detail}</small>{/if}
</li>

<style>
	.panel-row {
		position: relative;
		display: grid;
		grid-template: 'code name value' auto '. detail detail' auto / 3.25rem minmax(0, 1fr) auto;
		align-items: baseline;
		column-gap: 0.5rem;
		padding-block: 0.375rem;
		min-block-size: var(--size-tap-min);
		min-inline-size: 0;
		font-size: var(--text-small);
	}
	.panel-row > * {
		min-inline-size: 0;
	}
	.panel-row[data-report-row] {
		/* The status sizes its column up to 9rem, room for its mark and word ("○ Retard inconnu")
		   on one line; a detail such as "(4 min après l’horaire)" wraps below, and the vehicle name
		   keeps the rest of the row. */
		grid-template-columns: 3.25rem minmax(0, 1fr) fit-content(9rem);
		overflow-wrap: anywhere;
	}
	.panel-row[data-report-row] .value {
		overflow-wrap: normal;
	}
	.panel-row[data-report-row] .value :global(.status-word) {
		white-space: nowrap;
	}
	.code {
		grid-area: code;
		min-inline-size: 0;
	}
	.stop-code {
		display: inline-block;
		vertical-align: middle;
		max-inline-size: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding-inline: 0.15em;
		font-family: var(--font-mono);
	}
	.name {
		grid-area: name;
		min-inline-size: 0;
		min-block-size: 1.5rem;
		text-align: start;
		cursor: pointer;
	}
	.name::after {
		content: '';
		position: absolute;
		inset: 0;
	}
	/* One line per field; the full name stays in the link's accessible name and title. */
	.panel-row:not([data-report-row]) .name,
	.panel-row:not([data-report-row]) small {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.value {
		grid-area: value;
		text-align: end;
		font-variant-numeric: tabular-nums;
		font-weight: 600;
	}
	small {
		grid-area: detail;
		min-inline-size: 0;
		color: var(--muted-foreground);
	}
</style>
