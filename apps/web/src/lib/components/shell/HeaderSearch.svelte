<script lang="ts">
	import { tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { resetFocusAfterNavigation, SearchInput } from '@yesid/ui/brand';
	import { delocalizePath, localizeHref, type Locale } from '#lib/i18n/index.ts';
	import { navPillCopy } from '#lib/i18n/messages.ts';
	import { createAddressLookup } from '#lib/search/addressLookup.svelte.ts';
	import {
		searchHitHref,
		searchPageHref,
		searchQueryState,
		searchScope,
		withAddresses,
		type SearchHit,
		type SearchList,
	} from '#lib/search/transitSearch.ts';
	import type { LivePresentation } from '#lib/v1/live/livePresentation.ts';
	import { headerSearchCopy, searchListNotice } from './headerSearch.copy.ts';
	import SearchResultsList from './SearchResultsList.svelte';
	import { carryFrameState } from '#lib/site/frameState.ts';

	interface Props {
		locale: Locale;
		providerId: string;
		/** The URL the reader sees, including shallow view changes. */
		url: URL;
		list: SearchList;
		presentation?: LivePresentation | null;
		query?: string;
		/**
		 * Inside the phone search sheet: the list stays under the field, Escape closes the sheet,
		 * and the sheet leads the reader to a chosen row or to the search page itself.
		 */
		sheet?: { dismiss: () => void; follow: (href: string) => void } | null;
	}

	let {
		locale,
		providerId,
		url,
		list,
		presentation = null,
		query = $bindable(''),
		sheet = null,
	}: Props = $props();

	const uid = $props.id();
	const listId = `${uid}-results`;
	const copy = $derived(navPillCopy[locale]);
	const text = $derived(query.trim());
	const queryState = $derived(searchQueryState(query));
	let open = $state(true);
	let form = $state<HTMLFormElement>();
	let results = $state<ReturnType<typeof SearchResultsList>>();
	let active = $state<string | null>(null);
	const lookup = createAddressLookup(() => ({ providerId, locale }));
	const asked = $derived(lookup.for(text));
	const shownList = $derived(asked?.state === 'done' ? withAddresses(list, asked.found) : list);
	const address = $derived.by(() => {
		const row = queryState === 'ready' && list.indexSettled !== false ? lookup.row(text) : null;
		return row ? { state: row, onask: () => lookup.ask(text) } : null;
	});
	const listed = $derived(
		queryState === 'ready' && (list.groups.length > 0 || !list.pending || address !== null),
	);
	const shown = $derived((open || sheet !== null) && queryState !== 'empty');
	const localized = (href: string) => carryFrameState(localizeHref(href, locale, providerId), url);
	const hrefs = $derived({
		hit: (hit: SearchHit) =>
			localized(
				searchHitHref(hit, { path: delocalizePath(url.pathname), params: url.searchParams }),
			),
		all: localized(searchPageHref(text, searchScope(list.groups[0]?.kind ?? null))),
		lines: localized('/lines'),
		stops: localized('/stops'),
	});

	// Totals are spoken once typing pauses, never on every keystroke or live poll.
	// A group that could not be searched is named, never counted as 0.
	const total = (kind: 'route' | 'stop' | 'vehicle' | 'page') =>
		list.unsearched.some((missing) => missing === kind)
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
		const counts =
			queryState === 'ready' && list.total > 0
				? say.totals(total('route'), total('stop'), total('vehicle') ?? 0, total('page') ?? 0)
				: '';
		const notice = searchListNotice(say, list, text, queryState);
		const notes = [
			notice,
			queryState === 'ready' && list.vehiclesNotTracked ? say.notTracked : '',
			outcome,
		]
			.filter(Boolean)
			.join(' ');
		return [counts && (notes ? `${counts}.` : counts), notes].filter(Boolean).join(' ');
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
		if (event.isComposing) return;
		if (event.key === 'Escape') {
			if (sheet) {
				event.preventDefault(); // no native clearing: the text waits for the next opening
				sheet.dismiss();
			} else if (shown) {
				event.preventDefault();
				open = false;
			} else query = '';
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
		if (event.key !== 'Enter' || queryState !== 'ready') return;
		event.preventDefault();
		if (shown && results?.choose()) return;
		const href = localized(searchPageHref(text));
		if (sheet) return sheet.follow(href);
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
	class:nav-search-sheet={sheet}
	role="search"
	onsubmit={(event) => event.preventDefault()}
	data-slot="nav-search"
>
	<div class="nav-search-field">
		<SearchInput
			type="search"
			role="combobox"
			name="network-search"
			bind:value={query}
			placeholder={headerSearchCopy[locale].inputLabel}
			label={copy.searchAria.all}
			aria-expanded={shown && listed}
			aria-controls={shown && listed ? listId : undefined}
			aria-autocomplete="list"
			aria-activedescendant={shown && active ? active : undefined}
			autocomplete="off"
			spellcheck="false"
			class={sheet ? 'py-2' : 'rounded-md py-2'}
			textSize={sheet ? 'body' : 'small'}
			onfocus={() => (open = true)}
			oninput={() => (open = true)}
			onkeydown={keydown}
		/>
	</div>
	<p class="sr-only" role="status">{announcement}</p>
	<div class="nav-search-panel" data-slot="nav-search-panel">
		{#if shown}
			<div class="nav-search-results">
				<SearchResultsList
					bind:this={results}
					bind:active
					id={listId}
					label={copy.searchAria.all}
					list={shownList}
					{address}
					query={text}
					{locale}
					{hrefs}
					{presentation}
					follow={sheet?.follow}
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
	.nav-search-field {
		width: clamp(11rem, 22cqi, 20rem);
		min-width: 0;
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
	/* The phone sheet: the field spans it and the list fills the rest, scrolling under the field. */
	.nav-search-sheet {
		flex: 1;
		flex-direction: column;
		align-items: stretch;
		/* Shrinks to the sheet, so the list scrolls and the pinned row stays on screen. */
		min-height: 0;
	}
	.nav-search-sheet .nav-search-field {
		flex: none;
		width: 100%;
	}
	.nav-search-sheet .nav-search-panel {
		position: static;
		width: auto;
		max-height: none;
		min-height: 0;
		margin-top: 0.75rem;
		opacity: 1;
		visibility: visible;
		transition: none;
	}
	.nav-search-sheet :global(.search-list) {
		max-height: none;
		padding: 0;
		background: none;
		border: 0;
		box-shadow: none;
		-webkit-backdrop-filter: none;
		backdrop-filter: none;
	}
	.nav-search-sheet :global(.search-list-option) {
		min-height: var(--size-tap-min);
		align-items: center;
	}
	@media (prefers-reduced-motion: reduce) {
		.nav-search-panel {
			transition: none;
		}
	}
</style>
