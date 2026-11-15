<script lang="ts">
	import { tick } from 'svelte';
	import { goto } from '$app/navigation';
	import SearchIcon from '@lucide/svelte/icons/search';
	import { resetFocusAfterNavigation } from '@yesid/ui/brand';
	import { delocalizePath, localizeHref, type Locale } from '#lib/i18n/index.ts';
	import { navPillCopy } from '#lib/i18n/messages.ts';
	import type { GeocodeSuggestion } from '#lib/geocode/types.ts';
	import {
		canSearchAddresses,
		searchHitHref,
		searchPageHref,
		withAddresses,
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
	const text = $derived(query.trim());
	let open = $state(true);
	let form = $state<HTMLFormElement>();
	let results = $state<ReturnType<typeof SearchResultsList>>();
	let active = $state<string | null>(null);
	// Addresses are sent only when the reader asks, for the text in the field at that moment.
	type Lookup = { query: string; state: 'loading' | 'done' | 'failed'; found: GeocodeSuggestion[] };
	let lookup = $state<Lookup | null>(null);
	const asked = $derived(lookup?.query === text ? lookup : null);
	const shownList = $derived(asked?.state === 'done' ? withAddresses(list, asked.found) : list);
	const address = $derived(
		!canSearchAddresses(text) || (asked?.state === 'done' && asked.found.length > 0)
			? null
			: {
					state: !asked
						? ('ask' as const)
						: asked.state === 'done'
							? ('none' as const)
							: asked.state,
					onask: askAddresses,
				},
	);
	async function askAddresses(): Promise<void> {
		const asking = text;
		const settle = (state: Lookup['state'], found: GeocodeSuggestion[] = []) => {
			if (lookup?.query === asking) lookup = { query: asking, state, found };
		};
		lookup = { query: asking, state: 'loading', found: [] };
		try {
			const response = await fetch(
				`/api/geocode?provider=${encodeURIComponent(providerId)}&lang=${locale}&q=${encodeURIComponent(asking)}&suggest=1&limit=2`,
			);
			if (!response.ok) return settle('failed');
			const payload = (await response.json()) as { results?: GeocodeSuggestion[] };
			settle('done', payload.results ?? []);
		} catch {
			settle('failed');
		}
	}
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
	// A group that could not be searched is named, never counted as 0.
	const total = (kind: 'route' | 'stop' | 'vehicle') =>
		kind !== 'vehicle' && list.unsearched.includes(kind)
			? null
			: (list.groups.find((group) => group.kind === kind)?.total ?? 0);
	const summary = $derived.by(() => {
		const say = headerSearchCopy[locale];
		if (!shown) return '';
		// What the requested address lookup answered, spoken whatever the transit result.
		const outcome =
			address?.state === 'none'
				? say.addressesNone(text)
				: address?.state === 'failed'
					? say.addressesFailed
					: '';
		if (list.total === 0 && !list.pending)
			return [say.noResult(text), outcome].filter(Boolean).join(' ');
		const counts = say.totals(total('route'), total('stop'), total('vehicle') ?? 0);
		const notes = [...list.unsearched.map(say.unsearched), outcome].filter(Boolean);
		return notes.length ? [counts && `${counts}.`, ...notes].filter(Boolean).join(' ') : counts;
	});
	let announcement = $state('');
	$effect(() => {
		void query; // every edit restarts the wait, a trailing space too, even when the totals stay the same
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
		autocomplete="off"
		spellcheck="false"
		class="nav-search-input"
		onfocus={() => (open = true)}
		oninput={() => (open = true)}
		onkeydown={keydown}
	/>
	<p class="sr-only" role="status">{announcement}</p>
	<div class="nav-search-panel" data-slot="nav-search-panel">
		{#if shown}
			<div class="nav-search-results">
				<SearchResultsList
					bind:this={results}
					bind:active
					id={listId}
					label={copy.searchAria[scoped]}
					list={shownList}
					{address}
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
