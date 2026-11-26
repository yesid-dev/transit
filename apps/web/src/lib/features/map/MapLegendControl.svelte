<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Button } from '@yesid/ui/button';
	import * as Sheet from '@yesid/ui/sheet';
	import ListIcon from '@lucide/svelte/icons/list';
	import type { Locale } from '#lib/i18n/index.ts';
	import { copy } from './map.copy';

	let {
		locale,
		hidden = false,
		content,
	}: { locale: Locale; hidden?: boolean; content: Snippet } = $props();
	let open = $state(false);
	const t = $derived(copy[locale]);
	let sheet = $state<HTMLElement | null>(null);
	$effect(() => {
		sheet?.setAttribute('tabindex', '0');
	});
	let trigger = $state<HTMLButtonElement | null>(null);
	$effect(() => {
		if (hidden) open = false;
	});
	function focusSheet(event: Event) {
		event.preventDefault();
		sheet?.focus();
	}
	function restoreFocus(event: Event) {
		event.preventDefault();
		trigger?.focus();
	}
</script>

<Sheet.Root bind:open>
	{#if !hidden}
		<div class="map-legend-fab" data-slot="map-legend-fab">
			<Sheet.Trigger bind:ref={trigger} aria-label={t.legend.title} aria-expanded={open}>
				{#snippet child({ props })}
					<Button
						{...props}
						variant="outline"
						size="icon-tap"
						class="map-legend-button"
						data-testid="map-legend-button"
						onclick={() => {
							open = !open;
						}}
					>
						<ListIcon size={20} aria-hidden="true" />
					</Button>
				{/snippet}
			</Sheet.Trigger>
		</div>
	{/if}
	<Sheet.Content
		bind:ref={sheet}
		side="bottom"
		modal={false}
		interactOutsideBehavior="close"
		showCloseButton={false}
		portalProps={{ to: trigger?.closest<HTMLElement>('[data-slot="app-shell"]') ?? 'body' }}
		class="map-legend-sheet border-0 bg-transparent p-0 shadow-none"
		data-slot="map-legend-sheet"
		onInteractOutside={(event) => {
			// The trigger's click owns the toggle; outside dismissal must not close first.
			if (event.target instanceof Node && trigger?.contains(event.target)) event.preventDefault();
		}}
		onOpenAutoFocus={focusSheet}
		onCloseAutoFocus={restoreFocus}
	>
		<Sheet.Title class="sr-only">{t.legend.title}</Sheet.Title>
		{@render content()}
	</Sheet.Content>
</Sheet.Root>

<style>
	.map-legend-fab {
		position: fixed;
		left: calc(var(--spacing) * 3);
		bottom: calc(var(--map-touch-row-bottom) + var(--expanded-map-credit, 0px));
		z-index: calc(var(--z-sheet) + 2);
		pointer-events: auto;
	}
	:global(.map-legend-button) {
		width: var(--size-tap-min);
		height: var(--size-tap-min);
		border-radius: var(--radius-pill);
		background: var(--card);
		box-shadow: var(--shadow-card);
		touch-action: manipulation;
	}
	:global(.map-legend-sheet.map-legend-sheet) {
		--legend-bottom: calc(var(--map-touch-row-bottom, 4.375rem) + var(--size-tap-min) + 0.5rem);
		inset: auto auto var(--legend-bottom) calc(var(--spacing) * 3);
		width: min(21rem, calc(100vw - 2rem));
		max-width: none;
		max-height: calc(
			100dvh - var(--announcement-height, 0px) - var(--legend-bottom) - var(--pill-h) - 2rem -
				env(safe-area-inset-top, 0px)
		);
		overflow-y: auto;
		overscroll-behavior: contain;
		transform-origin: left bottom;
	}
	:global(.map-legend-sheet:focus-visible) {
		outline: calc(var(--spacing) / 2) solid var(--ring);
		outline-offset: calc(var(--spacing) / -2);
	}
	:global(.map-legend-sheet[data-state='open']) {
		animation: transit-sheet-in var(--duration-slow) var(--ease-out) both;
	}
	:global(.map-legend-sheet[data-state='closed']) {
		animation: transit-sheet-out var(--duration-normal) var(--ease-out) both;
	}
	@media (prefers-reduced-motion: reduce) {
		:global(.map-legend-sheet[data-state]) {
			animation: none;
			transition: none;
		}
	}
</style>
