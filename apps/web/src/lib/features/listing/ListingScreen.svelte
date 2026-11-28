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
		headingInAnswer = false,
		introClass,
		answerBusy,
		edgeBeforeResults = false,
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
		answer: Snippet<[Snippet | undefined]>;
		headingInAnswer?: boolean;
		introClass?: string;
		answerBusy?: boolean;
		edgeBeforeResults?: boolean;
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

{#snippet heading()}
	<ScreenTitle title={head.title} subtitle={head.subtitle ?? undefined} />
{/snippet}

{#snippet intro()}
	<div class={['grid min-w-0 content-start gap-(--space-card-gap)', introClass]}>
		{#if !headingInAnswer}{@render heading()}{/if}
		<div class="min-w-0" data-slot="screen-answer" aria-busy={answerBusy}>
			{@render answer(headingInAnswer ? heading : undefined)}
		</div>
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
				{@render summary?.()}
				{@render sort?.()}
				{@render children(more)}
			</div>
		</RecordCard>
	</div>
	{@render related?.()}
{/snippet}

<Surface>
	<RecordScreen class="min-w-0">
		<div class="min-w-0" data-slot="screen-content">
			{#if edgeBeforeResults}
				<RecordGroup>{@render intro()}</RecordGroup>
				<RecordGroup>{@render results()}</RecordGroup>
			{:else}
				<RecordGroup>
					{@render intro()}
					{@render results()}
				</RecordGroup>
			{/if}
			{#if about}<RecordGroup>{@render about()}</RecordGroup>{/if}
		</div>
	</RecordScreen>
</Surface>
