<script lang="ts">
	import { Button } from '@yesid/ui/button';
	import { SearchInput, StatusMark } from '@yesid/ui/brand';
	import { getV1Context } from '#lib/v1/boot.ts';
	import { onMount } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import type { GeocodeSuggestion } from '#lib/geocode/types.ts';
	import type { Locale } from '#lib/i18n/index.ts';
	import { canSearchAddresses } from '#lib/search/transitSearch.ts';
	import { trackEvent } from '#lib/site/analytics.ts';
	import type { MapCopy } from './map.copy';

	let {
		query = $bindable(''),
		locale,
		copy: t,
		loading,
		error,
		onsearch,
		onsuggestion,
	}: {
		query?: string;
		locale: Locale;
		copy: MapCopy;
		loading: boolean;
		error: string | null;
		onsearch: (event: SubmitEvent) => void | Promise<void>;
		onsuggestion: (result: GeocodeSuggestion) => void | Promise<void>;
	} = $props();

	const { manifest } = getV1Context();
	const id = $props.id();
	let items = $state<GeocodeSuggestion[]>([]);
	let pending = $state(false);
	let showing = $state(false);
	let input = $state<HTMLInputElement | null>(null);
	let active = $state(-1);
	const cached = new SvelteMap<string, GeocodeSuggestion[]>();
	const listOpen = $derived(showing && items.length > 0);
	const optionId = (index: number) => `${id}-option-${index}`;
	onMount(() => {
		if (!loading) input?.focus({ preventScroll: true });
	});

	function closeSuggestions() {
		showing = false;
		active = -1;
	}

	function choose(item: GeocodeSuggestion) {
		closeSuggestions();
		trackEvent('Address Pick');
		void onsuggestion(item);
	}

	function keydown(event: KeyboardEvent) {
		if (event.isComposing) return;
		if (event.key === 'Escape' && listOpen) {
			event.preventDefault();
			event.stopPropagation();
			closeSuggestions();
			return;
		}
		if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && items.length > 0) {
			event.preventDefault();
			showing = true;
			const step = event.key === 'ArrowDown' ? 1 : -1;
			active =
				active < 0
					? step === 1
						? 0
						: items.length - 1
					: (active + step + items.length) % items.length;
			document.getElementById(optionId(active))?.scrollIntoView?.({ block: 'nearest' });
		}
		if (event.key === 'Enter' && listOpen && items[active]) {
			event.preventDefault();
			choose(items[active]!);
		}
	}

	$effect(() => {
		const text = query.trim();
		const provider = manifest.provider;
		const language = locale;
		items = [];
		pending = false;
		if (!showing || !canSearchAddresses(text)) return;
		const key = `${provider}:${language}:${text.toLocaleLowerCase(language)}`;
		const hit = cached.get(key);
		if (hit) {
			items = hit;
			return;
		}
		const request = new AbortController();
		const debounce = setTimeout(async () => {
			pending = true;
			try {
				const params = new URLSearchParams({
					provider,
					lang: language,
					q: text,
					suggest: '1',
					limit: '4',
				});
				const response = await fetch(`/api/geocode?${params}`, { signal: request.signal });
				if (!response.ok) return;
				const { results = [] } = (await response.json()) as { results?: GeocodeSuggestion[] };
				if (request.signal.aborted) return;
				cached.set(key, results);
				items = results;
			} catch {
				// The explicit Find action reports a failed search. The input still accepts typing.
			} finally {
				if (!request.signal.aborted) pending = false;
			}
		}, 250);
		return () => {
			clearTimeout(debounce);
			request.abort();
		};
	});
</script>

<form
	class="grid min-w-0 gap-2"
	data-slot="map-address-lookup"
	aria-label={t.nearMeAddressLabel}
	onsubmit={(event) => {
		closeSuggestions();
		void onsearch(event);
	}}
>
	<SearchInput
		bind:ref={input}
		bind:value={query}
		label={t.nearMeAddressLabel}
		placeholder={t.nearMeAddressHint}
		visibleLabel
		textSize="body"
		role="combobox"
		aria-autocomplete="list"
		aria-expanded={listOpen}
		aria-controls={listOpen ? `${id}-suggestions` : undefined}
		aria-activedescendant={listOpen && active >= 0 ? optionId(active) : undefined}
		aria-busy={pending || loading}
		aria-describedby={`${id}-privacy`}
		autocomplete="off"
		enterkeyhint="search"
		spellcheck={false}
		oninput={() => {
			active = -1;
			showing = true;
		}}
		onblur={closeSuggestions}
		onkeydown={keydown}
	/>
	{#if listOpen}
		<div
			id={`${id}-suggestions`}
			class="suggestions"
			role="listbox"
			aria-label={t.nearMeSuggestions}
		>
			{#each items as item, index (`${item.label}:${item.lat}:${item.lon}`)}
				<button
					type="button"
					role="option"
					id={optionId(index)}
					aria-selected={active === index}
					tabindex="-1"
					onpointerdown={(event) => event.preventDefault()}
					onclick={() => choose(item)}
				>
					{item.label}
					<small>{t.precision[item.precision]}</small>
				</button>
			{/each}
		</div>
	{/if}
	<p id={`${id}-privacy`} class="text-sm text-muted-foreground">{t.nearMeCollectionNotice}</p>
	{#if loading}
		<p role="status" class="text-sm text-muted-foreground">{t.nearMeLoading}</p>
	{:else if error}
		<p role="status" class="lookup-message text-sm">
			<StatusMark
				status="unknown"
				label={query.trim() && error === t.nearMeError ? t.nearMeNotFound(query.trim()) : error}
			/>
		</p>
	{/if}
	<Button
		variant="outline"
		size="sm"
		type="submit"
		class="min-h-11 w-fit"
		disabled={loading || !query.trim()}
	>
		{t.nearMeSearchSubmit}
	</Button>
</form>

<style>
	.suggestions {
		display: grid;
		min-inline-size: 0;
		max-block-size: 12rem;
		overflow-y: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--popover);
	}
	.suggestions button {
		display: grid;
		min-block-size: var(--size-tap-min);
		padding: 0.375rem 0.75rem;
		text-align: start;
		overflow-wrap: break-word;
	}
	.suggestions button:is(:hover, [aria-selected='true']) {
		background: var(--muted);
	}
	.suggestions small {
		color: var(--muted-foreground);
	}
	.lookup-message :global([data-slot='status-mark']) {
		display: inline;
		color: var(--muted-foreground);
	}
	.lookup-message :global(.status-glyph) {
		display: inline-block;
		vertical-align: -0.15em;
		margin-inline-end: 0.25em;
	}
	.lookup-message :global(.status-word) {
		font-weight: 400;
	}
</style>
