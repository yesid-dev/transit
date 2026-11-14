<script lang="ts">
	import { tick } from 'svelte';
	import { goto } from '$app/navigation';
	import SearchIcon from '@lucide/svelte/icons/search';
	import { resetFocusAfterNavigation } from '@yesid/ui/brand';
	import { delocalizePath, localizeHref, type Locale } from '#lib/i18n/index.ts';
	import { navPillCopy } from '#lib/i18n/messages.ts';
	import {
		searchHitHref,
		searchPageHref,
		type ChromeSearchScope,
		type SearchHit,
		type SearchList,
	} from '#lib/search/transitSearch.ts';
	import type { LivePresentation } from '#lib/v1/live/livePresentation.ts';
	import { headerSearchCopy } from './headerSearch.copy.ts';
	import SearchResultsList from './SearchResultsList.svelte';

	interface Props {
		locale: Locale;
		providerId: string;
		/** The URL the reader sees, including shallow view changes. */
		url: URL;
		scope: ChromeSearchScope;
		list: SearchList;
		presentation?: LivePresentation | null;
		query?: string;
	}

	let {
		locale,
		providerId,
		url,
		scope,
		list,
		presentation = null,
		query = $bindable(''),
	}: Props = $props();

	const uid = $props.id();
	const listId = `${uid}-results`;
	const copy = $derived(navPillCopy[locale]);
	const scoped = $derived(scope === 'route' || scope === 'stop' ? scope : 'all');
	const transmits = $derived(scope === 'map' || scope === 'all');
	const text = $derived(query.trim());
	let open = $state(true);
	let form = $state<HTMLFormElement>();
	let results = $state<ReturnType<typeof SearchResultsList>>();
	let active = $state<string | null>(null);
	const listed = $derived(list.groups.length > 0 || (list.total === 0 && !list.pending));
	const shown = $derived(
		open && text.length > 0 && (listed || (presentation?.notice.kind ?? 'none') !== 'none'),
	);
	const localized = (href: string) => localizeHref(href, locale, providerId);
	const hrefs = $derived({
		hit: (hit: SearchHit) =>
			localized(
				searchHitHref(hit, { path: delocalizePath(url.pathname), params: url.searchParams }),
			),
		all: localized(searchPageHref(text)),
		lines: localized('/lines'),
		stops: localized('/stops'),
	});

	// Totals are spoken once typing pauses, never on every keystroke or live poll.
	const total = (kind: string) => list.groups.find((group) => group.kind === kind)?.total ?? 0;
	const summary = $derived.by(() => {
		const say = headerSearchCopy[locale];
		if (!shown || list.total === 0) return shown && !list.pending ? say.noResult(text) : '';
		return say.totals(total('route'), total('stop'), total('vehicle'));
	});
	let announcement = $state('');
	$effect(() => {
		const next = summary;
		const timer = setTimeout(() => (announcement = next), 500);
		return () => clearTimeout(timer);
	});

	function close(): void {
		query = '';
		open = false;
	}

	async function keydown(event: KeyboardEvent): Promise<void> {
		if (event.key === 'Escape') {
			if (shown) open = false;
			else query = '';
			return;
		}
		if (event.key === 'Tab') open = false;
		if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && text) {
			event.preventDefault();
			open = true;
			await tick();
			results?.move(event.key === 'ArrowDown' ? 1 : -1);
			return;
		}
		if (event.key !== 'Enter' || !text) return;
		event.preventDefault();
		if (shown && results?.choose()) return;
		const href = hrefs.all;
		close();
		const resetFocus = resetFocusAfterNavigation();
		await goto(href);
		resetFocus();
	}
</script>

<svelte:window
	onpointerdown={(event) => {
		if (form && event.target instanceof Node && !form.contains(event.target)) open = false;
	}}
/>

<form
	bind:this={form}
	class="nav-search"
	role="search"
	onsubmit={(event) => event.preventDefault()}
	data-slot="nav-search"
>
	<SearchIcon class="nav-search-icon" size={14} strokeWidth={1.8} aria-hidden="true" />
	<input
		type="search"
		role="combobox"
		name="network-search"
		bind:value={query}
		placeholder={copy.searchPlaceholder[scoped]}
		aria-label={copy.searchAria[scoped]}
		aria-expanded={shown && listed}
		aria-controls={shown && listed ? listId : undefined}
		aria-autocomplete="list"
		aria-activedescendant={shown && active ? active : undefined}
		aria-describedby={transmits ? 'nav-search-notice' : undefined}
		autocomplete="off"
		spellcheck="false"
		class="nav-search-input"
		onfocus={() => (open = true)}
		oninput={() => (open = true)}
		onkeydown={keydown}
	/>
	<p class="sr-only" role="status">{announcement}</p>
	{#if transmits}
		<span id="nav-search-notice" class="sr-only">{copy.searchCollectionNotice}</span>
	{/if}
	<div class="nav-search-panel" data-slot="nav-search-panel">
		{#if transmits}
			<p class="nav-search-notice" aria-hidden="true">{copy.searchCollectionNotice}</p>
		{/if}
		{#if shown}
			<div class="nav-search-results">
				<SearchResultsList
					bind:this={results}
					bind:active
					id={listId}
					label={copy.searchAria[scoped]}
					{list}
					query={text}
					{locale}
					{hrefs}
					{presentation}
					onchoose={close}
				/>
			</div>
		{/if}
	</div>
</form>

<style>
	.nav-search {
		position: relative;
		display: flex;
		align-items: center;
		min-width: 0;
	}
	.nav-search :global(.nav-search-icon) {
		position: absolute;
		left: 0.5rem;
		pointer-events: none;
		color: var(--muted-foreground);
	}
	.nav-search-input {
		width: clamp(11rem, 22cqi, 20rem);
		min-width: 0;
		height: var(--size-tap-min);
		padding: 0 0.75rem 0 1.9rem;
		font-size: var(--text-small);
		color: var(--foreground);
		background: color-mix(in srgb, var(--muted) 70%, transparent);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-pill);
		transition:
			border-color var(--duration-fast) var(--ease-default),
			background var(--duration-fast) var(--ease-default),
			box-shadow var(--duration-fast) var(--ease-default);
	}
	.nav-search-input::placeholder {
		color: var(--muted-foreground);
	}
	.nav-search-input:focus-visible {
		border-color: var(--primary);
		background: var(--muted);
		outline: none;
		box-shadow: 0 0 0 2px var(--ring);
	}
	.nav-search-panel {
		position: absolute;
		z-index: var(--z-nav);
		top: calc(100% + 1.75rem);
		left: 0;
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		width: min(max(100%, 28rem), calc(100vw - 2rem));
		max-height: calc(100dvh - 1rem - env(safe-area-inset-top, 0px) - var(--pill-h) - 10px - 1rem);
		opacity: 0;
		visibility: hidden;
		transition:
			opacity var(--duration-normal) var(--ease-default),
			visibility 0s linear var(--duration-normal);
	}
	.nav-search:focus-within .nav-search-panel,
	.nav-search:has(.nav-search-results) .nav-search-panel {
		opacity: 1;
		visibility: visible;
		transition:
			opacity var(--duration-fast) var(--ease-default),
			visibility 0s linear 0s;
	}
	.nav-search-notice {
		margin: 0;
		padding: 0.375rem 0.75rem;
		font-size: var(--text-caption);
		color: var(--muted-foreground);
		background: color-mix(in srgb, var(--background) 96%, transparent);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-lg);
	}
	.nav-search-results {
		display: flex;
		min-height: 0;
		flex-direction: column;
	}
	@media (prefers-reduced-motion: reduce) {
		.nav-search-input,
		.nav-search-panel {
			transition: none;
		}
	}
</style>
