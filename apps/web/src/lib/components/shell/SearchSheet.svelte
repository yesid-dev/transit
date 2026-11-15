<script lang="ts" module>
	/** Makes everything outside `node` inert, up to the body; returns the undo. */
	function inertOutside(node: Element): () => void {
		const made: Element[] = [];
		for (let inside = node; inside.parentElement && inside !== document.body; ) {
			for (const sibling of inside.parentElement.children)
				if (sibling !== inside && !sibling.hasAttribute('inert')) {
					sibling.setAttribute('inert', '');
					made.push(sibling);
				}
			inside = inside.parentElement;
		}
		return () => made.forEach((element) => element.removeAttribute('inert'));
	}
</script>

<script lang="ts">
	import { pushState } from '$app/navigation';
	import { page } from '$app/state';
	import SearchIcon from '@lucide/svelte/icons/search';
	import XIcon from '@lucide/svelte/icons/x';
	import { getLenis } from '@yesid/motion/utils/lenis';
	import { SectionLabel } from '@yesid/ui/brand';
	import { Button } from '@yesid/ui/button';
	import * as Sheet from '@yesid/ui/sheet';
	import type { Locale } from '#lib/i18n/index.ts';
	import type { ChromeSearchScope, SearchList } from '#lib/search/transitSearch.ts';
	import type { LivePresentation } from '#lib/v1/live/livePresentation.ts';
	import HeaderSearch from './HeaderSearch.svelte';
	import { headerSearchCopy } from './headerSearch.copy.ts';

	interface Props {
		locale: Locale;
		providerId: string;
		/** The URL the reader sees, including shallow view changes. */
		url: URL;
		scope: ChromeSearchScope;
		list: SearchList;
		presentation?: LivePresentation | null;
		query?: string;
		/** The trigger's accessible name: the field's own. */
		label: string;
	}

	let {
		locale,
		providerId,
		url,
		scope,
		list,
		presentation = null,
		query = $bindable(''),
		label,
	}: Props = $props();

	const copy = $derived(headerSearchCopy[locale]);
	let open = $state(false);
	let trigger = $state<HTMLButtonElement | null>(null);
	let content = $state<HTMLElement | null>(null);
	// Inside the app's root, so the router follows its links; outside the header, whose glass would clip it.
	const portal = $derived(trigger?.closest('[data-slot="app-shell"]') ?? 'body');
	// The sheet has its own history entry: the back gesture closes it, and a chosen row replaces it.
	const entry = $derived(page.state.searchSheet === true);
	let leaving = false;
	let restore: (() => void) | null = null;

	function opened(): void {
		leaving = false;
		const lenis = getLenis();
		lenis?.scrollTo(lenis.scroll, { immediate: true });
		pushState('', { ...page.state, searchSheet: true });
	}
	function dismiss(): void {
		open = false;
		if (entry) history.back();
	}
	function leave(): void {
		leaving = true;
		open = false;
		// The page is live again at once, so the router can announce where the reader lands.
		restore?.();
		restore = null;
	}

	let hadEntry = false;
	$effect(() => {
		const now = entry;
		if (hadEntry && !now) open = false;
		hadEntry = now;
	});
	$effect(() => () => restore?.());

	// Phones keep the page under their keyboard: fit the sheet to what stays visible.
	$effect(() => {
		const viewport = window.visualViewport;
		const sheet = content;
		if (!open || !sheet || !viewport) return;
		const fit = () =>
			sheet.style.setProperty('--search-sheet-h', `${viewport.height * viewport.scale}px`);
		fit();
		viewport.addEventListener('resize', fit);
		return () => viewport.removeEventListener('resize', fit);
	});
</script>

<Sheet.Root bind:open onOpenChange={(next) => (next ? opened() : entry && history.back())}>
	<Sheet.Trigger
		bind:ref={trigger}
		class="tap-press nav-compact-search"
		aria-label={label}
		data-slot="nav-compact-search"
	>
		<SearchIcon size={17} strokeWidth={1.8} aria-hidden="true" />
	</Sheet.Trigger>
	<Sheet.Content
		bind:ref={content}
		side="bottom"
		showCloseButton={false}
		portalProps={{ to: portal }}
		class="search-sheet"
		style="z-index: calc(var(--z-nav) + 1)"
		data-slot="search-sheet"
		data-lenis-prevent
		onOpenAutoFocus={(event) => {
			event.preventDefault();
			if (content) restore = inertOutside(content);
			content?.querySelector<HTMLInputElement>('[role="combobox"]')?.focus();
		}}
		onCloseAutoFocus={(event) => {
			event.preventDefault();
			restore?.();
			restore = null;
			// After a choice the new page takes focus and the text goes, as in the desktop list.
			if (leaving) query = '';
			else trigger?.focus({ preventScroll: true });
		}}
	>
		<div class="search-sheet-top">
			<Sheet.Title class="min-w-0 flex-1">
				<SectionLabel text={copy.sheetTitle} variant="station" />
			</Sheet.Title>
			<Button
				variant="ghost"
				size="icon-tap"
				type="button"
				class="-mr-2 text-muted-foreground"
				aria-label={copy.closeSheet}
				onclick={dismiss}
			>
				<XIcon size={18} strokeWidth={2.3} aria-hidden="true" />
			</Button>
		</div>
		<div class="search-sheet-body" data-sveltekit-replacestate={entry ? '' : 'off'}>
			<HeaderSearch
				bind:query
				{locale}
				{providerId}
				{url}
				{scope}
				{list}
				{presentation}
				sheet={{ replace: entry, dismiss, leave }}
			/>
		</div>
	</Sheet.Content>
</Sheet.Root>

<style>
	:global(.nav-compact-search) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 44px;
		height: 44px;
		padding: 0;
		color: var(--secondary-foreground);
		background: transparent;
		border-radius: var(--radius-lg);
		cursor: pointer;
		transition:
			color var(--duration-fast) var(--ease-default),
			background var(--duration-fast) var(--ease-default);
	}
	:global(.nav-compact-search:hover) {
		color: var(--primary);
		background: var(--muted);
	}
	:global(.nav-compact-search:focus-visible) {
		outline: 2px solid var(--ring);
		outline-offset: 1px;
	}
	/* From a 1024 px header the field itself is in the header. */
	@container site-header (width >= 1024px) {
		:global(.nav-compact-search) {
			display: none;
		}
	}

	/* Full screen, above the header; the field and its list stay clear of notches and home bars. */
	:global([data-slot='search-sheet'].search-sheet) {
		inset: 0;
		height: var(--search-sheet-h, 100dvh);
		max-height: none;
		gap: 0;
		padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px)
			env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
		border: 0;
		border-radius: 0;
	}
	.search-sheet-top {
		display: flex;
		flex: none;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 1rem 0.25rem;
	}
	.search-sheet-body {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-height: 0;
		padding: 0.25rem 1rem 0.75rem;
	}

	@media (prefers-reduced-motion: reduce) {
		:global(.nav-compact-search) {
			transition: none;
		}
	}
</style>
