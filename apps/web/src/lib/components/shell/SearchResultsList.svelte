<script lang="ts">
	import FreshnessStamp from '#lib/components/surface/FreshnessStamp.svelte';
	import type { Locale } from '#lib/i18n/index.ts';
	import type { SearchHit, SearchList } from '#lib/search/transitSearch.ts';
	import { trackEvent } from '#lib/site/analytics.ts';
	import type { LivePresentation } from '#lib/v1/live/livePresentation.ts';
	import { headerSearchCopy } from './headerSearch.copy.ts';

	interface Props {
		id: string;
		label: string;
		list: SearchList;
		/** The text as typed, quoted back in messages. */
		query: string;
		locale: Locale;
		hrefs: { hit: (hit: SearchHit) => string; all: string; lines: string; stops: string };
		presentation?: LivePresentation | null;
		/** The highlighted option's id: what Enter opens. */
		active?: string | null;
		onchoose?: () => void;
	}

	let {
		id,
		label,
		list,
		query,
		locale,
		hrefs,
		presentation = null,
		active = $bindable(null),
		onchoose,
	}: Props = $props();
	let box = $state<HTMLElement>();

	const copy = $derived(headerSearchCopy[locale]);
	const unmatched = $derived(list.total === 0 && !list.pending);
	const live = $derived(
		presentation != null &&
			(presentation.notice.kind !== 'none' || list.groups.some((g) => g.kind === 'vehicle')),
	);
	const optionId = (hit: SearchHit) => `${id}-${hit.kind}-${encodeURIComponent(hit.id)}`;
	const detail = (hit: SearchHit) =>
		hit.kind === 'stop' ? hit.code : hit.line ? `${copy.kind.route} ${hit.line}` : null;

	// An exact first row is highlighted as the list shows; otherwise none. Live polls keep the choice.
	const exactId = $derived(list.exact ? optionId(list.groups[0]!.hits[0]!) : null);
	// A folded query has no "|", so this key changes exactly when the query or exact row does.
	const rule = $derived(`${list.query}|${exactId}`);
	$effect.pre(() => {
		void rule;
		active = exactId;
	});

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

	function chose(event: MouseEvent, hit?: SearchHit): void {
		if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
			return;
		if (hit) trackEvent('Search Result', { kind: hit.kind });
		onchoose?.();
	}
</script>

{#snippet option(optionKey: string, href: string, text: string, hit?: SearchHit)}
	<a
		id={optionKey}
		{href}
		role="option"
		tabindex="-1"
		aria-selected={active === optionKey}
		class="search-list-option"
		onclick={(event) => chose(event, hit)}
	>
		{#if hit}<span class="search-list-kind">{copy.kind[hit.kind]}</span>{/if}
		<span class="search-list-label">{text}</span>
		{#if hit && detail(hit)}<small>{detail(hit)}</small>{/if}
	</a>
{/snippet}

<div class="search-list" data-slot="search-results-list">
	{#if live && presentation}
		<div class="search-list-live">
			<FreshnessStamp variant="live" presentation={presentation.stamp} {locale} />
			{#if presentation.notice.kind !== 'none'}<p role="status">
					{presentation.notice.message}
				</p>{/if}
		</div>
	{/if}
	{#if unmatched}<p class="search-list-none">{copy.noResult(query)}</p>{/if}
	{#if list.groups.length || unmatched}
		<div bind:this={box} {id} role="listbox" aria-label={label} class="search-list-box">
			<div class="search-list-scroll">
				<!-- Above any address rows, so rows already shown never move when addresses arrive. -->
				{#if unmatched}
					{@render option(`${id}-lines`, hrefs.lines, copy.browseLines)}
					{@render option(`${id}-stops`, hrefs.stops, copy.browseStops)}
				{/if}
				{#each list.groups as group (group.kind)}
					<div role="group" aria-labelledby={`${id}-${group.kind}`}>
						<div role="presentation" id={`${id}-${group.kind}`} class="search-list-heading">
							{copy.heading(group.kind, group.kind === 'address' ? null : group.total)}
						</div>
						{#each group.hits as hit (hit.id)}
							{@render option(optionId(hit), hrefs.hit(hit), hit.label, hit)}
						{/each}
					</div>
				{/each}
			</div>
			{#if list.total > 0}
				<div class="search-list-pinned">
					{@render option(`${id}-all`, hrefs.all, copy.seeAll(list.total, query))}
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
		align-items: flex-start;
		gap: 0.375rem;
		min-height: 2.25rem;
		padding: 0.375rem 0.5rem;
		font-family: var(--font-mono);
		font-size: var(--text-caption);
		line-height: 1.25;
		color: var(--foreground);
		text-decoration: none;
		background: var(--muted);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-sm);
	}
	.search-list-option:hover,
	.search-list-option[aria-selected='true'] {
		color: var(--primary);
		background: color-mix(in srgb, var(--primary) 10%, var(--muted) 90%);
		border-color: color-mix(in srgb, var(--primary) 44%, var(--border) 56%);
	}
	.search-list-option[aria-selected='true'] {
		outline: 2px solid var(--ring);
		outline-offset: -2px;
	}
	.search-list-kind {
		flex: none;
		padding: 0.125rem 0.375rem;
		color: var(--primary);
		background: color-mix(in srgb, var(--primary) 10%, transparent);
		border: 1px solid color-mix(in srgb, var(--primary) 34%, transparent);
		border-radius: var(--radius-pill);
	}
	.search-list-label {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.search-list-option small {
		flex: none;
		color: var(--muted-foreground);
	}
</style>
