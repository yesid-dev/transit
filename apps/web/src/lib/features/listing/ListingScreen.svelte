<script lang="ts">
	import { getContext, untrack, type Snippet } from 'svelte';
	import { SearchInput, type StampProps } from '@yesid/ui/brand';
	import { Button } from '@yesid/ui/button';
	import { Surface, type SurfaceRailContext } from '@yesid/ui/layout';
	import {
		frameSurfaceRailContext,
		type RegisterFrameSurfaceRail,
	} from '#lib/components/shell/frameSurfaceRail.ts';
	import type { Locale } from '#lib/i18n/index.ts';
	import RecordCard from '../record/RecordCard.svelte';
	import RecordGroup from '../record/RecordGroup.svelte';
	import RecordScreen from '../record/RecordScreen.svelte';
	import ScreenTitle from '../record/ScreenTitle.svelte';

	type Search = {
		url: { pathname: string; searchParams: Iterable<[string, string]> };
		exclude?: readonly string[];
		value: string;
		label: string;
		placeholder: string;
		description?: string;
		hint?: string;
		id?: string;
		testId?: string;
		onInput: (value: string) => void;
		onSubmit: () => void;
	};

	let {
		locale,
		head,
		answer,
		introClass,
		answerBusy,
		filters,
		title,
		titleAside,
		titleLevel = 2,
		search,
		searchInput = $bindable(null),
		searchActions,
		summary,
		resultCountText = '',
		sort,
		children,
		more,
		related,
		about,
		card,
		cardElement = $bindable(),
	}: {
		locale: Locale;
		head: { title: string; subtitle?: string | null };
		answer: Snippet;
		introClass?: string;
		answerBusy?: boolean;
		filters?: Snippet<[SurfaceRailContext]>;
		title: string;
		titleAside?: StampProps;
		titleLevel?: 2 | 3;
		search?: Search;
		searchInput?: HTMLInputElement | null;
		searchActions?: Snippet;
		summary?: Snippet;
		resultCountText?: string;
		sort?: Snippet;
		children: Snippet<[Snippet | undefined]>;
		more?: Snippet;
		related?: Snippet;
		about?: Snippet;
		card?: {
			id?: string;
			class?: string;
			busy?: boolean;
			retained?: boolean;
			stampRule?: boolean;
			stampPending?: boolean;
			interactive?: boolean;
			evidence?: Snippet;
		};
		cardElement?: HTMLDivElement;
	} = $props();

	const register = getContext<RegisterFrameSurfaceRail | undefined>(frameSurfaceRailContext);
	const uid = $props.id();
	const searchHint = `${uid}-search-hint`;
	$effect(() => {
		const rail = filters;
		if (rail) return untrack(() => register?.(rail));
	});
</script>

{#snippet intro()}
	<div class="listing-heading min-w-0" data-screen-intro>
		<ScreenTitle title={head.title} subtitle={head.subtitle ?? undefined} />
	</div>
	<div
		class={['listing-reading min-w-0', introClass]}
		data-slot="screen-answer"
		aria-busy={answerBusy}
	>
		{@render answer()}
	</div>
{/snippet}

{#snippet results()}
	<div
		id={card?.id}
		bind:this={cardElement}
		class="min-w-0"
		class:opacity-65={card?.retained}
		aria-busy={card?.busy}
	>
		<RecordCard
			{title}
			{titleLevel}
			stamp={titleAside}
			stampRule={card?.stampRule}
			stampPending={card?.stampPending}
			interactive={card?.interactive ?? true}
			evidence={card?.evidence}
			class={card?.class}
		>
			<div class="grid min-w-0 gap-3" data-slot="listing-body">
				{#if search}
					<form
						method="GET"
						action={search.url.pathname}
						class="w-full max-w-xl"
						data-slot="listing-search"
						onsubmit={(event) => {
							event.preventDefault();
							search?.onSubmit();
						}}
					>
						{#each [...search.url.searchParams].filter(([key]) => key !== 'q' && !search?.exclude?.includes(key)) as [key, value], index (index)}
							<input type="hidden" name={key} {value} />
						{/each}
						<SearchInput
							bind:ref={searchInput}
							id={search.id}
							name="q"
							type="search"
							testId={search.testId}
							visibleLabel
							textSize="body"
							class="pr-2"
							label={search.label}
							placeholder={search.placeholder}
							description={search.description}
							aria-describedby={search.hint ? searchHint : undefined}
							value={search.value}
							oninput={(event) => search?.onInput(event.currentTarget.value)}
						/>
						{#if search.hint}<p id={searchHint} class="sr-only">{search.hint}</p>{/if}
						<noscript>
							<Button type="submit" variant="outline">
								{locale === 'fr' ? 'Rechercher' : 'Search'}
							</Button>
						</noscript>
					</form>
				{/if}
				{@render searchActions?.()}
				{#if search}<p class="sr-only" role="status">{resultCountText}</p>{/if}
				{#if summary}
					<div class="listing-summary text-small text-muted-foreground" data-slot="listing-summary">
						{@render summary()}
					</div>
				{/if}
				{@render sort?.()}
				{@render children(more)}
			</div>
		</RecordCard>
	</div>
	{@render related?.()}
{/snippet}

<Surface>
	<RecordScreen class="min-w-0">
		<div class="listing-screen min-w-0" data-slot="screen-content">
			<RecordGroup class="listing-group">
				{@render intro()}
				<div class="listing-results min-w-0">
					{@render results()}
				</div>
			</RecordGroup>
			{#if about}<RecordGroup>{@render about()}</RecordGroup>{/if}
		</div>
	</RecordScreen>
</Surface>

<style>
	.listing-screen {
		container: listing-screen / inline-size;
	}

	:global(.listing-group) {
		row-gap: 0.75rem;
	}

	.listing-reading {
		--listing-heading-reserve: 4.6875rem;
	}

	.listing-results {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-card-gap);
		margin-block-start: calc(var(--space-card-gap) - 0.75rem);
	}

	@media (width >= 80rem) {
		.listing-results {
			margin-block-start: calc(var(--space-card-gap) - 1.75rem);
		}
	}

	@container listing-screen (min-width: 44rem) {
		.listing-reading {
			--listing-heading-reserve: 3.5rem;
		}
	}

	/* The answer follows the title in the DOM. Subgrid lets the stamp and actions share the title row. */
	@container listing-screen (min-width: 64rem) {
		:global(.listing-group) {
			grid-template-columns: minmax(0, 1fr) max-content max-content;
			grid-template-rows: auto auto auto;
			column-gap: 1rem;
		}

		.listing-heading {
			grid-column: 1;
			grid-row: 1;
			z-index: 1;
		}

		.listing-reading {
			--listing-heading-reserve: 0rem;
			display: grid;
			grid-column: 1 / -1;
			grid-row: 1 / span 3;
			grid-template-columns: subgrid;
			grid-template-rows: subgrid;
		}

		.listing-reading > :global(:not([data-slot='record-answer'])) {
			grid-column: 1 / -1;
			grid-row: 2 / -1;
		}

		.listing-results {
			grid-column: 1 / -1;
		}
	}

	.listing-summary:not(:has(> *)) {
		display: none;
	}

	.listing-summary :global([data-slot='filter-summary']) {
		margin-block-end: 0;
	}

	.listing-summary :global([data-slot='filter-summary-count']) {
		font-size: inherit;
		line-height: inherit;
		color: inherit;
	}
</style>
