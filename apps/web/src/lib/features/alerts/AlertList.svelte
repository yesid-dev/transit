<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { RoutePlate, SegmentedChoice } from '@yesid/ui/brand';
	import { Button } from '@yesid/ui/button';
	import { Card } from '@yesid/ui/card';
	import { Combobox } from '@yesid/ui/combobox';
	import { ControlsRail, type SurfaceRailContext } from '@yesid/ui/layout';
	import { ShowMore } from '@yesid/ui/table';
	import { getContext, tick, untrack } from 'svelte';
	import { SvelteURL } from 'svelte/reactivity';
	import type { Locale } from '#lib/i18n/index.ts';
	import {
		frameSurfaceRailContext,
		type RegisterFrameSurfaceRail,
	} from '#lib/components/shell/frameSurfaceRail.ts';
	import { choose, tally } from '#lib/features/record/recordText.ts';
	import { localizeHref } from '#lib/i18n/routing.ts';
	import { foldSearchText } from '#lib/search/normalize.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { alertPaging } from '#lib/site/presenter.ts';
	import {
		agencyMessage,
		agencyMessageLink,
		agencyMessagePeriods,
		sortAgencyMessages,
	} from '#lib/site/agencyMessages.ts';
	import { alertEffect, alertTarget, unstatedEffect, type AlertCard } from './alertCards.ts';

	let {
		cards,
		locale,
		city,
		timeZone,
		live,
	}: {
		cards: AlertCard[];
		locale: Locale;
		city: string;
		timeZone?: string;
		live: boolean;
	} = $props();

	const pageSize = 12;
	const registerControls = getContext<RegisterFrameSurfaceRail | undefined>(
		frameSurfaceRailContext,
	);
	const display = transitDisplay();
	const t = (en: string, fr: string) => choose(locale, en, fr);
	const location = $derived(page.shallow?.url ?? page.url);
	const line = $derived(location.searchParams.get('route') ?? '');
	const stop = $derived(location.searchParams.get('stop') ?? '');
	const hasEffects = $derived(cards.some(({ effect }) => effect != null));
	const selectedEffect = $derived(hasEffects ? (location.searchParams.get('effect') ?? '') : '');
	const effectKey = (card: AlertCard) => card.effect ?? unstatedEffect;
	const effects = $derived(
		[...new Set(cards.map(effectKey))].sort((a, b) =>
			alertEffect(a, locale).localeCompare(alertEffect(b, locale), locale),
		),
	);
	const lines = $derived(
		[...new Set(cards.flatMap(({ routes }) => routes))].sort((a, b) =>
			display.line(a).localeCompare(display.line(b), locale, { numeric: true }),
		),
	);
	const stops = $derived(
		[...new Set(cards.flatMap((card) => card.stops))].sort((a, b) =>
			a.localeCompare(b, locale, { numeric: true }),
		),
	);
	const lineOptions = $derived(choices(lines, line, (id) => display.lineName(id).label));
	const stopOptions = $derived(choices(stops, stop, (id) => t(`Stop ${id}`, `Arrêt ${id}`)));
	const effectOptions = $derived(choices(effects, selectedEffect, (id) => alertEffect(id, locale)));
	const activeFilters = $derived(Boolean(line || stop || selectedEffect));
	const hasControls = $derived(
		cards.length > 0 && Boolean(lineOptions.length || stopOptions.length || hasEffects),
	);
	const filterKeys = ['route', 'stop', 'effect'] as const;
	type FilterKey = (typeof filterKeys)[number];
	const target = $derived(alertTarget(new URL(location.href)));
	const filtered = $derived(
		sortAgencyMessages(
			cards.filter(
				(card) =>
					(!line || card.routes.includes(line)) &&
					(!stop || card.stops.includes(stop)) &&
					(!selectedEffect || effectKey(card) === selectedEffect),
			),
			locale,
			display.line,
		),
	);
	const ordered = $derived.by(() => {
		const index = filtered.findIndex((card) => card.id === target);
		if (index < pageSize) return filtered;
		return [filtered[index], ...filtered.slice(0, index), ...filtered.slice(index + 1)];
	});
	const selectedOutsideFilters = $derived(
		target && !filtered.some(({ id }) => id === target)
			? cards.find(({ id }) => id === target)
			: undefined,
	);

	let paging = $state<{ line: string; stop: string; effect: string; shown: number }>();
	const shown = $derived(
		Math.min(
			ordered.length,
			paging?.line === line && paging.stop === stop && paging.effect === selectedEffect
				? paging.shown
				: pageSize,
		),
	);
	const labels = $derived(alertPaging(locale));

	let list = $state<HTMLUListElement>();
	let lastJump: string | null = null;
	const anchor = (id: string) => `alert-${id}`;
	const resultCount = $derived(
		`${tally(ordered.length, locale)} ${t(ordered.length === 1 ? 'alert' : 'alerts', 'avis')}`,
	);

	$effect(() => {
		if (hasControls) {
			return untrack(() => registerControls?.(controls));
		}
	});

	$effect(() => {
		if (!target) lastJump = null;
		if (target && target !== lastJump && cards.some(({ id }) => id === target)) {
			lastJump = target;
			void tick().then(() => document.getElementById(anchor(target))?.scrollIntoView());
		}
	});

	async function showMore(count: number) {
		const previous = shown;
		paging = { line, stop, effect: selectedEffect, shown: shown + count };
		await tick();
		(list?.children[previous] as HTMLElement | undefined)?.focus();
	}

	function choices(ids: string[], selected: string, name: (id: string) => string) {
		return (selected && !ids.includes(selected) ? [...ids, selected] : ids).map((value) => {
			const label = name(value);
			return { value, label, search: foldSearchText(`${label} ${value}`) };
		});
	}

	function applyFilter(key?: FilterKey, value?: string | null) {
		const url = new SvelteURL(location.href);
		if (!key) filterKeys.forEach((filterKey) => url.searchParams.delete(filterKey));
		else if (value) url.searchParams.set(key, value);
		else url.searchParams.delete(key);
		if (url.href === location.href) return;
		url.searchParams.delete('alert');
		url.hash = '';
		paging = undefined;
		void goto(url, { shallow: true, state: { ...page.state } });
	}
</script>

{#snippet controls(context: SurfaceRailContext)}
	<ControlsRail label={t('Filter', 'Filtrer')}>
		<div class="grid w-full min-w-0 gap-3">
			{#if lineOptions.length}
				<Combobox
					options={lineOptions}
					value={line || null}
					onValueChange={(value) => applyFilter('route', value)}
					label={t('Line', 'Ligne')}
					placeholder={t('All lines', 'Toutes les lignes')}
					clearLabel={t('Clear line', 'Effacer la ligne')}
					emptyLabel={t('No matching lines', 'Aucune ligne correspondante')}
					fold={foldSearchText}
				/>
			{/if}
			{#if stopOptions.length}
				<Combobox
					options={stopOptions}
					value={stop || null}
					onValueChange={(value) => applyFilter('stop', value)}
					label={t('Stop', 'Arrêt')}
					placeholder={t('All stops', 'Tous les arrêts')}
					clearLabel={t('Clear stop', 'Effacer l’arrêt')}
					emptyLabel={t('No matching stops', 'Aucun arrêt correspondant')}
					fold={foldSearchText}
				/>
			{/if}
			{#if hasEffects}
				{@const allEffects = t('All effects', 'Tous les effets')}
				{#if effectOptions.length < 5}
					<SegmentedChoice
						label={t('Effect', 'Effet')}
						value={selectedEffect}
						options={[
							{ key: '', label: allEffects },
							...effectOptions.map(({ value: key, label }) => ({ key, label })),
						]}
						variant="joined-grid"
						onSelect={(value) => applyFilter('effect', value)}
					/>
				{:else}
					<Combobox
						options={effectOptions}
						value={selectedEffect || null}
						onValueChange={(value) => applyFilter('effect', value)}
						label={t('Effect', 'Effet')}
						placeholder={allEffects}
						clearLabel={t('Clear effect', 'Effacer l’effet')}
						emptyLabel={t('No matching effects', 'Aucun effet correspondant')}
						fold={foldSearchText}
					/>
				{/if}
			{/if}
			<div class="flex min-w-0 flex-wrap items-center justify-between gap-x-2 text-small">
				<p role={context.presentation === 'mobile' ? 'status' : undefined}>{resultCount}</p>
				<Button
					variant="outline"
					class="min-h-11"
					aria-disabled={!activeFilters}
					onclick={() => activeFilters && applyFilter()}>{t('Clear', 'Effacer')}</Button
				>
			</div>
		</div>
	</ControlsRail>
{/snippet}

{#snippet item(card: AlertCard, anchorId: string | undefined)}
	{@const { title, body } = agencyMessage(card, locale)}
	{@const source = agencyMessageLink(card, locale)}
	{@const periods = agencyMessagePeriods(card.periods, locale, timeZone, live)}
	<li id={anchorId} tabindex="-1" class="min-w-0 scroll-mt-24">
		<Card
			textSize="inherit"
			interactive={Boolean(card.routes.length || card.stops.length || source)}
			class="min-w-0 px-4 sm:px-6"
		>
			<div class="min-w-0">
				<div
					class="flex flex-wrap items-center gap-x-3"
					class:single-plate={card.routes.length === 1}
				>
					{#if card.routes.length}
						<div class="flex min-w-0 flex-wrap items-center gap-x-1">
							{#each [...new Set(card.routes)] as route (route)}
								<a
									class="inline-flex min-h-11 min-w-11 items-center justify-center"
									href={localizeHref(`/lines/${encodeURIComponent(route)}`, locale, city)}
								>
									<RoutePlate code={display.line(route)} />
									<span class="sr-only"> {display.lineName(route).label}</span>
								</a>
							{/each}
						</div>
					{/if}
					<div class="min-w-0">
						<h3 class="wrap-break-word font-semibold" lang={title.lang}>
							{title.text}
						</h3>
						{#if card.effect || periods.length}
							<p class="wrap-break-word text-small text-muted-foreground">
								{#if card.effect}{alertEffect(card.effect, locale)}.
								{/if}
								{periods.join(live ? ' ' : ' · ')}
							</p>
						{/if}
					</div>
				</div>
				{#if card.stops.length}
					<div class="flex min-w-0 flex-wrap items-center gap-x-1 text-small text-muted-foreground">
						<span>{t('Stops', 'Arrêts')}</span>
						{#each [...new Set(card.stops)] as stop (stop)}
							<a
								class="inline-flex min-h-11 min-w-11 items-center justify-center text-primary underline"
								href={localizeHref(`/stop/${encodeURIComponent(stop)}`, locale, city)}
							>
								<span class="rounded-sm border border-current px-1 font-mono">{stop}</span>
							</a>
						{/each}
					</div>
				{/if}
				{#if body}<p
						class="mt-1 max-w-[var(--measure-body)] wrap-break-word whitespace-pre-line"
						lang={body.lang}
					>
						{body.text}
					</p>{/if}
			</div>
			{#if source}
				<a
					class="inline-flex min-h-11 items-center text-primary underline"
					href={source.href}
					hreflang={source.lang}
				>
					{t('Agency notice', 'Avis de l’agence')}
				</a>
			{/if}
		</Card>
	</li>
{/snippet}

{#if cards.length}
	{#if selectedOutsideFilters}
		<ul class="alert-list">
			{@render item(selectedOutsideFilters, anchor(selectedOutsideFilters.id))}
		</ul>
	{/if}
	{#if ordered.length}
		<ul bind:this={list} class="alert-list grid gap-[var(--space-card-gap)]">
			{#each ordered.slice(0, shown) as card, index (card.key)}
				{@render item(
					card,
					ordered.findIndex(({ id }) => id === card.id) === index ? anchor(card.id) : undefined,
				)}
			{/each}
		</ul>
		<ShowMore {shown} total={ordered.length} {pageSize} {labels} onMore={showMore} />
	{:else}
		<p role="status">
			{t('No alerts match these filters.', 'Aucun avis ne correspond à ces filtres.')}
		</p>
	{/if}
{:else}
	<p>{t('No alerts in effect.', 'Aucun avis en vigueur.')}</p>
{/if}

<style>
	.alert-list {
		container-type: inline-size;
	}

	@container (inline-size >= 12rem) {
		.single-plate {
			display: grid;
			grid-template-columns: auto minmax(0, 1fr);
		}
	}
</style>
