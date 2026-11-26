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
	import { untrack } from 'svelte';
	import { goto, pushState, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import SearchIcon from '@lucide/svelte/icons/search';
	import XIcon from '@lucide/svelte/icons/x';
	import { getLenis } from '@yesid/motion/utils/lenis';
	import { resetFocusAfterNavigation, SectionLabel } from '@yesid/ui/brand';
	import { Button } from '@yesid/ui/button';
	import * as Sheet from '@yesid/ui/sheet';
	import type { Locale } from '#lib/i18n/index.ts';
	import type { SearchList } from '#lib/search/transitSearch.ts';
	import type { LivePresentation } from '#lib/v1/live/livePresentation.ts';
	import HeaderSearch from './HeaderSearch.svelte';
	import { headerSearchCopy } from './headerSearch.copy.ts';

	interface Props {
		locale: Locale;
		providerId: string;
		/** The URL the reader sees, including shallow view changes. */
		url: URL;
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
	// The sheet has its own shallow history entry, so the back gesture closes it.
	const entry = $derived(page.state.searchSheet === true);
	let leaving = false;
	let restore: (() => void) | null = null;
	// Settles once the router has taken the reader off the sheet's entry.
	let offEntry: (() => void) | null = null;

	function opened(): void {
		leaving = false;
		const lenis = getLenis();
		lenis?.scrollTo(lenis.scroll, { immediate: true });
		// Already on the sheet's entry (a choice whose navigation never happened): reuse it.
		if (!entry) void pushState('', { ...page.state, searchSheet: true });
	}
	function dismiss(): void {
		open = false;
		if (entry) history.back();
	}
	/**
	 * Leads the reader to a chosen row or the search page. The sheet first leaves its own entry, so
	 * the record is an ordinary navigation from the page the search began on. Replacing the shallow
	 * entry instead left the record with that page's navigation index, and Back then changed only
	 * the URL: the record stayed on screen.
	 */
	async function follow(href: string): Promise<void> {
		leaving = true;
		open = false;
		// The page is live again at once, so the router can announce where the reader lands.
		restore?.();
		restore = null;
		if (entry)
			await new Promise<void>((done) => {
				offEntry = done;
				setTimeout(done, 1000); // never stranded if the router does not answer
				history.back();
			});
		const resetFocus = resetFocusAfterNavigation();
		await goto(href);
		resetFocus();
	}

	const visible = (element: HTMLElement | null) =>
		element !== null && getComputedStyle(element).display !== 'none';
	/**
	 * The button that opens the sheet at this header width: the phone trigger below a 1024 px
	 * header, the icon button beside the page links up to 1280 px, none where the field shows.
	 */
	const shownButton = (): HTMLElement | null =>
		[
			trigger,
			...(trigger
				?.closest('[data-slot="site-header"]')
				?.querySelectorAll<HTMLElement>('[data-slot="nav-search-button"]') ?? []),
		].find(visible) ?? null;

	/** Opens the sheet from a button outside it (the icon button beside the page links). */
	export function show(): void {
		if (open) return;
		open = true;
		opened();
	}

	// The sheet follows its entry both ways: Back closes it, Forward opens it again. From a
	// 1280 px header the field sits in the header, so a restored entry loses its flag instead.
	let hadEntry = false;
	$effect(() => {
		const now = entry;
		if (now !== hadEntry)
			untrack(() => {
				if (!now) {
					open = false;
					offEntry?.();
					offEntry = null;
				} else if (open || leaving) return;
				else if (shownButton()) open = true;
				else void replaceState('', { ...page.state, searchSheet: undefined });
			});
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
			else if (shownButton()) shownButton()?.focus({ preventScroll: true });
			// A header that widened while the sheet was open shows the field instead of the button.
			else
				trigger
					?.closest('[data-slot="site-header"]')
					?.querySelector<HTMLInputElement>('[data-slot="nav-search"] input')
					?.focus({ preventScroll: true });
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
		<div class="search-sheet-body">
			<HeaderSearch
				bind:query
				{locale}
				{providerId}
				{url}
				{list}
				{presentation}
				sheet={{ dismiss, follow }}
			/>
		</div>
	</Sheet.Content>
</Sheet.Root>

<style>
	:global(.nav-compact-search) {
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		gap: 0.375rem;
		min-width: 44px;
		height: 44px;
		padding: 0 0.5rem;
		white-space: nowrap;
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
	/* From a 1024 px header the search sits in SiteHeader's search slot: an icon button beside the
	   page links, then from a 1280 px header the field itself. */
	@container site-header (width >= 1024px) {
		:global(.nav-compact-search:not([data-slot='nav-search-button'])) {
			display: none;
		}
	}
	:global([data-slot='nav-search-button']) {
		display: none;
	}
	@container site-header (1024px <= width < 1280px) {
		:global(.nav-compact-search[data-slot='nav-search-button']) {
			display: inline-flex;
		}
	}
	/* Like the desktop field, the phone trigger folds away while the menu is open. */
	:global([role='dialog'][aria-modal='true'] .nav-compact-search) {
		display: none;
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
