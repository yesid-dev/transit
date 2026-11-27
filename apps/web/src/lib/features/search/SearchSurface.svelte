<script lang="ts">
	import RecordScreen from '#lib/features/record/RecordScreen.svelte';
	import RecordGroup from '#lib/features/record/RecordGroup.svelte';
	import { onMount, tick, untrack } from 'svelte';
	import { page } from '$app/state';
	import { afterNavigate } from '$app/navigation';
	import { Surface } from '@yesid/ui/layout';
	import { SearchInput } from '@yesid/ui/brand';
	import { Button } from '@yesid/ui/button';
	import { Card } from '@yesid/ui/card';
	import { Tabs, TabsContent, TabsList, TabsTrigger } from '@yesid/ui/tabs';
	import { getLocale, getLocalizeHref } from '#lib/i18n/index.ts';
	import { createResource } from '#lib/v1/resource.svelte.ts';
	import { providerHasAlerts } from '#lib/v1/providers.ts';
	import ScreenTitle from '#lib/features/record/ScreenTitle.svelte';
	import SearchResultsList from '#lib/components/shell/SearchResultsList.svelte';
	import { headerSearchCopy } from '#lib/components/shell/headerSearch.copy.ts';
	import { mirrorSearchParams } from '#lib/site/urlMirror.ts';
	import { searchCount } from '#lib/site/presenter.ts';
	import { createAddressLookup } from '#lib/search/addressLookup.svelte.ts';
	import { sitePages } from '#lib/search/sitePages.ts';
	import { loadSearchIndex, searchIndexList } from '#lib/search/searchIndex.ts';
	import {
		searchHitHref,
		searchQueryState,
		searchScope,
		SEARCH_KINDS,
		withAddresses,
		type SearchHit,
		type SearchScope,
	} from '#lib/search/transitSearch.ts';
	import { copy } from './search.copy';

	const PAGE_SIZE = 6;
	const KINDS = ['all', ...SEARCH_KINDS] as const;
	const id = $props.id();
	const provider = $derived(page.data.provider);
	const providerId = $derived(page.data.providerId ?? '');
	const locale = $derived(getLocale());
	const localizeHref = getLocalizeHref();
	const t = $derived(copy[locale]);
	let field = $state<HTMLDivElement>();
	onMount(() => {
		const input = field?.querySelector('input');
		if (!input || !window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) return;
		input.focus();

		const autofocus = new AbortController();
		const once = { once: true, signal: autofocus.signal };
		const finish = () => autofocus.abort();
		// A first Tab from the untouched field starts the normal page tab order at the skip link.
		input.addEventListener(
			'keydown',
			(event) => {
				if (event.key !== 'Tab' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey)
					return;
				const skip = document.querySelector<HTMLAnchorElement>('a.skip-link[href="#main"]');
				if (!skip) return;
				event.preventDefault();
				skip.focus();
			},
			once,
		);
		input.addEventListener('pointerdown', finish, once);
		input.addEventListener('input', finish, once);
		input.addEventListener('blur', finish, once);
		return finish;
	});
	const words = $derived(headerSearchCopy[locale]);
	const labels = $derived(provider?.labels[locale]);
	const subtitle = $derived(labels && `${labels.operator}, ${labels.city}`);

	// Existing links may carry a previously revealed row count.
	function rowsFrom(value: string | null): number {
		const n = /^[1-9]\d*$/.test(value ?? '') ? Number(value) : NaN;
		return Number.isSafeInteger(n) && n >= PAGE_SIZE ? n : PAGE_SIZE;
	}
	const initial = untrack(() => page.url.searchParams);
	let query = $state(initial.get('q') ?? '');
	let scope = $state<SearchScope>(searchScope(initial.get('kind')));
	let rows = $state(rowsFrom(initial.get('rows')));

	afterNavigate(({ type, to }) => {
		if (type === 'enter' || !to) return;
		const params = to.url.searchParams;
		query = params.get('q') ?? '';
		scope = searchScope(params.get('kind'));
		rows = rowsFrom(params.get('rows'));
	});

	const text = $derived(query.trim());
	const queryState = $derived(searchQueryState(text));
	const index = createResource((signal) => loadSearchIndex(providerId, signal), {
		enabled: () => providerId !== '',
		key: () => providerId,
	});
	const pages = $derived(sitePages({ alerts: provider ? providerHasAlerts(provider) : null }));
	const examples = $derived.by(() => {
		const schedule = index.error ? null : index.data?.schedule;
		const line = schedule?.routes.find(({ short }) => /^\d+$/.test(short));
		const stop = schedule?.stops.find(({ code }) => code && /^\d{3,}$/.test(code));
		return [
			...new Set([line?.short, stop?.code, t.stopsLabel].filter((word): word is string => !!word)),
		];
	});
	const list = $derived(
		searchIndexList({ query, rows: scope === 'all' ? PAGE_SIZE : rows }, index, {
			locale,
			nameSeparators: provider?.name_separators,
			pages,
		}),
	);

	$effect(() => {
		const params = {
			q: text || null,
			kind: scope === 'all' ? null : scope,
			mode: null,
			rows: scope !== 'all' && rows > PAGE_SIZE ? String(rows) : null,
		};
		untrack(() => mirrorSearchParams(params));
	});

	const tabs = $derived(
		KINDS.map((key) => {
			if (key === 'all') return { key, label: t.scopeAll };
			const label = words.kinds[key];
			const known =
				!list.unsearched.some((kind) => kind === key) &&
				!(key === 'vehicle' && list.vehiclesNotTracked);
			const total = list.groups.find((group) => group.kind === key)?.total ?? 0;
			return {
				key,
				label: known && queryState === 'ready' ? `${label} (${searchCount(total, locale)})` : label,
			};
		}),
	);

	const lookup = createAddressLookup(() => ({ providerId, locale }));
	const address = $derived(scope === 'all' && queryState === 'ready' ? lookup.row(text) : null);
	const asked = $derived(lookup.for(text));
	const shown = $derived(
		scope === 'all' && asked?.state === 'done' ? withAddresses(list, asked.found) : list,
	);
	const addressText = $derived(
		address === 'loading'
			? words.addressesLoading
			: address === 'failed'
				? words.addressesFailed
				: address === 'none'
					? words.addressesNone(text)
					: words.askAddresses(text),
	);
	async function ask() {
		if (address !== 'ask') return;
		await lookup.ask(text);
		await tick();
		document
			.getElementById(id)
			?.querySelector<HTMLAnchorElement>('[data-kind="address"] a')
			?.focus();
	}

	const hrefs = $derived({
		hit: (hit: SearchHit) =>
			localizeHref(
				searchHitHref(hit, {
					path: '/search',
					params: new URLSearchParams(),
				}),
				locale,
			),
	});
	const resultPage = $derived({
		scope,
		pageSize: PAGE_SIZE,
		onMore: (kind: Exclude<SearchScope, 'all'>, count: number) => {
			rows = (scope === 'all' ? PAGE_SIZE : rows) + count;
			scope = kind;
		},
		onRetry: index.reload,
		retryLabel: t.retry,
	});
</script>

<!-- One centred column: the title, the field and the results share its edges at every width. -->
<Surface>
	<div class="search-column" data-slot="search-column">
		<RecordScreen>
			<RecordGroup><ScreenTitle title={words.sheetTitle} {subtitle} compact /></RecordGroup>
			<RecordGroup
				><div data-slot="screen-content">
					<section
						class="search-content"
						data-slot="screen-state"
						{id}
						aria-label={words.sheetTitle}
					>
						<p class="search-lede">{t.lede}</p>
						<div bind:this={field}>
							<SearchInput
								label={t.inputLabel}
								placeholder={t.examples(examples.join(', '))}
								visibleLabel
								textSize="body"
								autocomplete="off"
								bind:value={
									() => query,
									(next) => {
										query = next;
										rows = PAGE_SIZE;
									}
								}
							/>
						</div>
						{#if queryState === 'empty'}
							<div class="search-idle p-0">
								<p class="font-semibold">{t.trySearch}</p>
								<ul class="flex flex-wrap gap-x-4">
									{#each examples as example (example)}<li>
											<a
												class="inline-flex min-h-11 min-w-11 items-center text-primary underline"
												href={'?' +
													new URLSearchParams({
														...(providerId && { provider: providerId }),
														q: example,
													})}
												onclick={(event) => {
													if (
														event.button ||
														event.metaKey ||
														event.ctrlKey ||
														event.shiftKey ||
														event.altKey
													)
														return;
													event.preventDefault();
													query = example;
													rows = PAGE_SIZE;
													field?.querySelector('input')?.focus();
												}}>{example}</a
											>
										</li>{/each}
								</ul>
								<a
									class="inline-flex min-h-11 items-center text-primary underline"
									href={localizeHref('/map', locale)}>{t.nearby}</a
								>
							</div>
						{:else}
							<Card
								textSize="inherit"
								interactive
								class="search-body min-w-0 px-4 sm:px-6"
								data-search-card=""
							>
								{#if queryState === 'short'}
									<SearchResultsList
										id={`${id}-results`}
										label={words.results}
										list={shown}
										query={text}
										{locale}
										{hrefs}
										page={resultPage}
									/>
								{:else}
									<Tabs
										value={scope}
										onValueChange={(next) => {
											rows = PAGE_SIZE;
											scope = searchScope(next);
										}}
									>
										<TabsList
											variant="line"
											class="flex h-auto w-full flex-wrap justify-start gap-1"
											aria-label={words.results}
										>
											{#each tabs as tab (tab.key)}
												<TabsTrigger
													value={tab.key}
													class="h-auto min-h-11 min-w-11 flex-none px-3 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
													>{tab.label}</TabsTrigger
												>
											{/each}
										</TabsList>
										{#each tabs as tab (tab.key)}
											<TabsContent
												value={tab.key}
												class="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring"
											>
												{#if scope === tab.key}
													<SearchResultsList
														id={`${id}-results`}
														label={words.results}
														list={shown}
														query={text}
														{locale}
														{hrefs}
														page={resultPage}
													/>
													{#if address}
														<div class="search-address">
															<p class="sr-only" role="status">
																{address === 'ask' ? '' : addressText}
															</p>
															<Button
																variant="outline"
																wrap
																type="button"
																aria-describedby={address === 'ask'
																	? `${id}-address-notice`
																	: undefined}
																aria-disabled={address === 'ask' ? undefined : 'true'}
																onclick={ask}>{addressText}</Button
															>
															{#if address === 'ask'}
																<p
																	id={`${id}-address-notice`}
																	class="text-small text-muted-foreground"
																>
																	{words.addressNotice}
																</p>
															{/if}
														</div>
													{/if}
												{/if}
											</TabsContent>
										{/each}
									</Tabs>
								{/if}
							</Card>
						{/if}
					</section>
				</div></RecordGroup
			>
		</RecordScreen>
	</div>
</Surface>

<style>
	/* The page's one column, centred: its left and right margins are equal at every width, and the
	   header pill overhangs it evenly. Narrower screens give it the whole width between the gutters. */
	.search-column {
		inline-size: 100%;
		max-inline-size: var(--measure-body);
		margin-inline: auto;
		min-width: 0;
	}
	/* The results, or the note before any typing, own the first screen in every state, so the
	   footer never jumps when the first letter is typed or the rows arrive (closing scan S1). */
	.search-content {
		display: grid;
		align-content: start;
		gap: var(--space-card-gap);
		min-width: 0;
		min-block-size: calc(100dvh - var(--app-frame-header-height, 0px));
		margin-block-end: var(--space-card-gap);
	}
	.search-lede {
		font-size: var(--text-reading-heading);
		line-height: 1.4;
	}
	.search-address {
		display: grid;
		justify-items: start;
		gap: 0.5rem;
		margin-block-start: 1rem;
	}
</style>
