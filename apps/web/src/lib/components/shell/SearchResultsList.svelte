<script lang="ts">
	import { tick } from 'svelte';
	import { RoutePlate } from '@yesid/ui/brand';
	import { ShowMore } from '@yesid/ui/table';
	import { Button } from '@yesid/ui/button';
	import FreshnessStamp from '#lib/components/surface/FreshnessStamp.svelte';
	import type { Locale } from '#lib/i18n/index.ts';
	import {
		searchQueryState,
		type ChromeSearchKind,
		type SearchHit,
		type SearchKind,
		type SearchList,
		type SearchScope,
	} from '#lib/search/transitSearch.ts';
	import { searchCount } from '#lib/site/presenter.ts';
	import { trackEvent } from '#lib/site/analytics.ts';
	import type { LivePresentation } from '#lib/v1/live/livePresentation.ts';
	import { headerSearchCopy, searchListNotice } from './headerSearch.copy.ts';

	interface Props {
		id: string;
		label: string;
		list: SearchList;
		/** The text as typed, quoted back in messages. */
		query: string;
		locale: Locale;
		hrefs: { hit: (hit: SearchHit) => string; all?: string; lines?: string; stops?: string };
		page?: {
			scope: SearchScope;
			pageSize: number;
			onMore: (kind: SearchKind, count: number) => void;
			onRetry: () => void;
			retryLabel: string;
		};
		presentation?: LivePresentation | null;
		/** The highlighted option's id: what Enter opens. */
		active?: string | null;
		/** The address row: a request to send, or what that request answered. */
		address?: { state: 'ask' | 'loading' | 'none' | 'failed'; onask: () => void } | null;
		/** Set by the phone sheet: it takes a plain click on a row and leads the reader there itself. */
		follow?: (href: string) => void;
		onchoose?: () => void;
	}

	let {
		id,
		label,
		list,
		query,
		locale,
		hrefs,
		page,
		presentation = null,
		active = $bindable(null),
		address = null,
		follow,
		onchoose,
	}: Props = $props();
	let box = $state<HTMLElement>();

	const copy = $derived(headerSearchCopy[locale]);
	const queryState = $derived(searchQueryState(query));
	const notice = $derived(searchListNotice(copy, list, query, queryState, page?.scope));
	const unmatched = $derived(queryState === 'ready' && list.total === 0 && !list.pending);
	const showNotTracked = $derived(
		list.vehiclesNotTracked && queryState === 'ready' && page?.scope !== 'vehicle',
	);
	const groups = $derived(
		list.groups.filter((group) => !page || page.scope === 'all' || group.kind === page.scope),
	);
	const live = $derived(
		presentation != null &&
			(presentation.notice.kind !== 'none' || list.groups.some((g) => g.kind === 'vehicle')),
	);
	const optionId = (hit: SearchHit) => `${id}-${hit.kind}-${encodeURIComponent(hit.id)}`;
	const heading = (kind: ChromeSearchKind, total: number) =>
		kind === 'address'
			? copy.heading(kind, null)
			: `${copy.kinds[kind]} · ${searchCount(total, locale)}`;
	const detail = (hit: SearchHit) =>
		hit.kind === 'route' && hit.mode
			? copy.modes[hit.mode]
			: hit.line
				? `${copy.kind.route} ${hit.line}`
				: null;

	let announcement = $state('');
	$effect(() => {
		const pageSize = page?.pageSize;
		if (!pageSize) return;
		const message =
			notice || groups.some((group) => group.total > pageSize)
				? ''
				: groups.map((group) => heading(group.kind, group.total)).join('. ');
		const timer = setTimeout(() => (announcement = message), 500);
		return () => clearTimeout(timer);
	});

	async function reveal(kind: SearchKind, shown: number, count: number) {
		page?.onMore(kind, count);
		await tick();
		const next = box?.querySelectorAll<HTMLAnchorElement>(`[data-kind="${kind}"] a`)[shown];
		next?.focus();
	}

	// An exact first row is highlighted as the list shows; otherwise none. Live polls keep the choice.
	const exactId = $derived(list.exact ? optionId(list.groups[0]!.hits[0]!) : null);
	// A folded query has no "|", so this key changes exactly when the query or exact row does.
	const rule = $derived(`${list.query}|${exactId}`);
	$effect.pre(() => {
		void rule;
		active = exactId;
	});

	// Addresses arrive because the reader asked: the first one takes the highlight.
	const firstAddress = $derived(list.groups.find((group) => group.kind === 'address')?.hits[0]);
	const firstAddressId = $derived(firstAddress ? optionId(firstAddress) : null);
	$effect.pre(() => {
		if (firstAddressId) active = firstAddressId;
	});
	const addressId = $derived(`${id}-address`);
	const addressText = $derived(
		address?.state === 'loading'
			? copy.addressesLoading
			: address?.state === 'none'
				? copy.addressesNone(query)
				: address?.state === 'failed'
					? copy.addressesFailed
					: copy.askAddresses(query),
	);

	/** Moves the highlight through every option, the pinned one included, and wraps. */
	export function move(step: 1 | -1): void {
		const options = [...(box?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
		if (!options.length) return;
		const at = options.findIndex((option) => option.id === active);
		const next =
			at < 0 ? (step > 0 ? 0 : options.length - 1) : (at + step + options.length) % options.length;
		active = options[next]!.id;
		options[next]!.scrollIntoView?.({ block: 'nearest' });
	}

	/** Opens the highlighted row; false when nothing is highlighted. */
	export function choose(): boolean {
		const option = active ? box?.ownerDocument.getElementById(active) : null;
		option?.click();
		return option != null;
	}

	function chose(event: MouseEvent, href: string, hit?: SearchHit): void {
		if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
			return;
		if (hit && hit.kind !== 'page') trackEvent('Search Result', { kind: hit.kind });
		if (!follow) return onchoose?.();
		event.preventDefault();
		follow(href);
	}
</script>

{#snippet option(optionKey: string, href: string, text: string, hit?: SearchHit)}
	<a
		id={optionKey}
		{href}
		role={page ? undefined : 'option'}
		tabindex={page ? undefined : -1}
		aria-selected={page ? undefined : active === optionKey}
		aria-label={!page && hit?.kind === 'stop'
			? [copy.kind.stop, hit.label, hit.code].filter(Boolean).join(' ')
			: undefined}
		class="search-list-option"
		class:coded={hit?.kind === 'route' || hit?.kind === 'stop'}
		onclick={(event) => chose(event, href, hit)}
	>
		{#if hit?.kind === 'route' && hit.code}
			<span class="search-list-code"
				><span class="sr-only">{copy.kind.route} </span><RoutePlate code={hit.code} /></span
			>
		{:else if hit?.kind === 'stop' && hit.code}
			<span class="search-list-code"
				><span class="sr-only">{copy.kind.stop} </span><span class="stop-code">{hit.code}</span
				></span
			>
		{/if}
		<span class="search-list-label">
			<span class="search-list-title">
				{#if hit?.kind === 'route' && hit.code}
					{#if hit.name}<span class="sr-only"> · </span>{hit.name}{/if}
				{:else}
					{#if hit && (hit.kind === 'vehicle' || hit.kind === 'address')}<span class="sr-only"
							>{copy.kind[hit.kind]}
						</span>{/if}{text}
				{/if}
			</span>
			{#if hit && detail(hit)}<small>{detail(hit)}</small>{/if}
		</span>
	</a>
{/snippet}

<div class="search-list" class:page-list={page} data-slot="search-results-list">
	{#if live && presentation}
		<div class="search-list-live">
			<FreshnessStamp variant="live" presentation={presentation.stamp} {locale} />
			{#if presentation.notice.kind !== 'none'}<p role="status">
					{presentation.notice.message}
				</p>{/if}
		</div>
	{/if}
	{#if page}
		<p role="status" class:sr-only={!notice} class:search-list-none={notice}>
			{notice || announcement}
		</p>
		{#if notice === copy.unavailable}<Button variant="outline" wrap onclick={page.onRetry}
				>{page.retryLabel}</Button
			>{/if}
	{:else if notice}
		<p class="search-list-none">{notice}</p>
	{/if}
	{#if showNotTracked}<p class="search-list-none">{copy.notTracked}</p>{/if}
	{#if page}
		<div bind:this={box} class="page-groups">
			{#each groups as group (group.kind)}
				<section data-kind={group.kind} aria-labelledby={`${id}-${group.kind}`}>
					<h2 id={`${id}-${group.kind}`} class="search-list-heading">
						{heading(group.kind, group.total)}
					</h2>
					<ul>
						{#each group.hits as hit (hit.id)}
							<li>{@render option(optionId(hit), hrefs.hit(hit), hit.label, hit)}</li>
						{/each}
					</ul>
					{#if group.kind !== 'address' && group.total > page.pageSize}
						<ShowMore
							shown={group.hits.length}
							total={group.total}
							pageSize={page.pageSize}
							labels={{
								showing: (shown, total) =>
									copy.showing(searchCount(shown, locale), searchCount(total, locale)),
								more: () => copy.more,
							}}
							onMore={(count) =>
								group.kind !== 'address' && reveal(group.kind, group.hits.length, count)}
						/>
					{/if}
				</section>
			{/each}
		</div>
	{:else if groups.length || unmatched || address}
		<div bind:this={box} {id} role="listbox" aria-label={label} class="search-list-box">
			<div class="search-list-scroll">
				<!-- Above any address rows, so rows already shown never move when addresses arrive. -->
				{#if unmatched && hrefs.lines && hrefs.stops}
					{@render option(`${id}-lines`, hrefs.lines, copy.browseLines)}
					{@render option(`${id}-stops`, hrefs.stops, copy.browseStops)}
				{/if}
				{#each groups as group (group.kind)}
					<div role="group" aria-labelledby={`${id}-${group.kind}`}>
						<div role="presentation" id={`${id}-${group.kind}`} class="search-list-heading">
							{heading(group.kind, group.total)}
						</div>
						{#each group.hits as hit (hit.id)}
							{@render option(optionId(hit), hrefs.hit(hit), hit.label, hit)}
						{/each}
					</div>
				{/each}
				<!-- Last, so nothing above it moves when the addresses replace it. -->
				{#if address}
					<button
						type="button"
						id={addressId}
						role="option"
						tabindex="-1"
						aria-selected={active === addressId}
						aria-disabled={address.state === 'ask' ? undefined : 'true'}
						aria-describedby={address.state === 'ask' ? `${addressId}-notice` : undefined}
						class="search-list-option search-list-address"
						onmousedown={(event) => event.preventDefault()}
						onclick={() => address.state === 'ask' && address.onask()}
					>
						<span class="search-list-label">{addressText}</span>
						{#if address.state === 'ask'}
							<small id={`${addressId}-notice`} aria-hidden="true">{copy.addressNotice}</small>
						{/if}
					</button>
				{/if}
			</div>
			{#if list.total > 0 && hrefs.all}
				<div class="search-list-pinned">
					{@render option(`${id}-all`, hrefs.all, copy.seeAll)}
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.search-list {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-height: 0;
		max-height: min(26rem, calc(100dvh - var(--pill-h) - 3rem));
		padding: 0.375rem;
		border-radius: var(--radius-lg);
		background: color-mix(in srgb, var(--background) 96%, transparent);
		border: 1px solid var(--border-brand);
		box-shadow: var(--shadow-nav);
		-webkit-backdrop-filter: blur(var(--glass-blur));
		backdrop-filter: blur(var(--glass-blur));
	}
	.search-list-live,
	.search-list-none {
		flex: none;
		margin: 0;
		padding: 0.25rem 0.5rem;
		font-size: var(--text-caption);
		color: var(--muted-foreground);
	}
	.search-list-none {
		color: var(--foreground);
	}
	.search-list-box {
		display: flex;
		flex-direction: column;
		min-height: 0;
	}
	.search-list-scroll {
		display: grid;
		gap: 0.25rem;
		min-height: 0;
		overflow-y: auto;
	}
	.search-list-heading {
		padding: 0.375rem 0.5rem 0.125rem;
		font-size: var(--text-caption);
		color: var(--muted-foreground);
	}
	.search-list-pinned {
		flex: none;
		margin-top: 0.25rem;
		padding-top: 0.375rem;
		border-top: 1px solid var(--border-subtle);
	}
	.search-list-option {
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 0.5rem;
		min-height: var(--size-tap-min);
		padding: 0.375rem 0.5rem;
		font-size: var(--text-small);
		line-height: 1.25;
		color: var(--foreground);
		text-decoration: none;
		background: var(--muted);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-sm);
	}
	/* A highlight, so the yellow pair; accent text on accent surface keeps AA in both themes. */
	.search-list-option:hover,
	.search-list-option[aria-selected='true'] {
		background: var(--accent-surface);
		border-color: color-mix(in srgb, var(--accent-text) 44%, var(--border) 56%);
	}
	.search-list-option[aria-selected='true'] {
		outline: 2px solid var(--ring);
		outline-offset: -2px;
	}
	.search-list-code {
		flex: 0 0 4.5em;
	}
	.stop-code {
		display: inline-block;
		padding: 0.125em 0.375em;
		border: 1px solid var(--foreground);
		border-radius: var(--radius-sm);
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
	}
	.search-list-label {
		flex: 1;
		min-width: 0;
	}
	.search-list-option small {
		display: block;
		color: var(--muted-foreground);
	}
	.page-list {
		gap: var(--space-card-gap);
		max-height: none;
		padding: 0;
		border: 0;
		background: none;
		box-shadow: none;
		backdrop-filter: none;
	}
	.page-list .search-list-none {
		padding: 0;
		font-size: inherit;
	}
	.page-groups {
		display: grid;
		gap: var(--space-card-gap);
	}
	.page-groups ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.page-groups h2 {
		padding: 0 0 0.5rem;
		font-size: var(--text-subheading);
		font-weight: 600;
	}
	.page-list .search-list-option {
		border: 0;
		border-block-start: 1px solid var(--border);
		border-radius: 0;
		background: transparent;
	}
	.search-list-option .search-list-title {
		color: var(--primary);
		text-decoration: underline;
	}
	.page-list .search-list-code,
	.page-list small {
		color: var(--foreground);
	}
	.search-list-option:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: -2px;
	}
	.coded {
		flex-wrap: wrap;
	}
	.coded .search-list-label {
		flex-basis: min(100%, 12em);
	}
	.search-list-address {
		flex-wrap: wrap;
		width: 100%;
		text-align: start;
		cursor: pointer;
	}
	.search-list-address small {
		flex-basis: 100%;
	}
	.search-list-address[aria-disabled='true'] {
		cursor: default;
	}
</style>
