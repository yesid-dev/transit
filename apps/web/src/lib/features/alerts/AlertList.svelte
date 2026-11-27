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
	import { choose } from '#lib/features/record/recordText.ts';
	import { localizeHref } from '#lib/i18n/routing.ts';
	import { foldSearchText } from '#lib/search/normalize.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { alertPaging, noticeCount, noticeLineName } from '#lib/site/presenter.ts';
	import {
		agencyMessage,
		agencyMessageLink,
		agencyMessagePeriods,
		sortAgencyMessages,
	} from '#lib/site/agencyMessages.ts';
	import {
		alertEffect,
		alertTarget,
		groupAlertCards,
		unstatedEffect,
		type AlertCard,
		type NoticeCard,
	} from './alertCards.ts';

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
	const lineOptions = $derived(
		choices(lines, line, (id) => {
			const { number, name } = display.lineName(id);
			const detail = noticeLineName(number ?? id, name);
			return detail ? `${number ?? id} · ${detail}` : (number ?? id);
		}),
	);
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
			groupAlertCards(
				cards,
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
		const index = target ? filtered.findIndex((card) => card.ids.includes(target)) : -1;
		if (index < pageSize) return filtered;
		return [filtered[index], ...filtered.slice(0, index), ...filtered.slice(index + 1)];
	});
	const selectedOutsideFilters = $derived(
		target && !filtered.some(({ ids }) => ids.includes(target))
			? groupAlertCards(cards).find(({ ids }) => ids.includes(target))
			: undefined,
	);
	const anchorOwners = $derived.by(() => {
		const owners: Record<string, string> = Object.create(null);
		for (const { key, ids } of ordered) {
			for (const id of ids) owners[id] ??= key;
		}
		return owners;
	});

	let paging = $state<{ line: string; stop: string; effect: string; shown: number }>();
	const shown = $derived(
		Math.min(
			ordered.length,
			paging?.line === line && paging.stop === stop && paging.effect === selectedEffect
				? paging.shown
				: pageSize,
		),
	);
	const labels = $derived(alertPaging(locale, true));

	let list = $state<HTMLUListElement>();
	let lastJump: string | null = null;
	const anchor = (id: string) => `alert-${id}`;
	const resultCount = $derived(noticeCount(ordered.length, locale));

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
				{@const label = t('Line', 'Ligne')}
				<div class="grid min-w-0 gap-1">
					<p aria-hidden="true" class="text-small text-muted-foreground">{label}</p>
					<Combobox
						options={lineOptions}
						value={line || null}
						onValueChange={(value) => applyFilter('route', value)}
						{label}
						placeholder={t('All', 'Toutes')}
						clearLabel={t('Clear line', 'Effacer la ligne')}
						emptyLabel={t('No matching lines', 'Aucune ligne correspondante')}
						fold={foldSearchText}
					/>
				</div>
			{/if}
			{#if stopOptions.length}
				{@const label = t('Stop', 'Arrêt')}
				<div class="grid min-w-0 gap-1">
					<p aria-hidden="true" class="text-small text-muted-foreground">{label}</p>
					<Combobox
						options={stopOptions}
						value={stop || null}
						onValueChange={(value) => applyFilter('stop', value)}
						{label}
						placeholder={t('All', 'Tous')}
						clearLabel={t('Clear stop', 'Effacer l’arrêt')}
						emptyLabel={t('No matching stops', 'Aucun arrêt correspondant')}
						fold={foldSearchText}
					/>
				</div>
			{/if}
			{#if hasEffects}
				{@const label = t('Effect', 'Effet')}
				{@const allEffects = t('All', 'Tous')}
				<div class="grid min-w-0 gap-1">
					<p aria-hidden="true" class="text-small text-muted-foreground">{label}</p>
					{#if effectOptions.length < 5}
						<SegmentedChoice
							{label}
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
							{label}
							placeholder={allEffects}
							clearLabel={t('Clear effect', 'Effacer l’effet')}
							emptyLabel={t('No matching effects', 'Aucun effet correspondant')}
							fold={foldSearchText}
						/>
					{/if}
				</div>
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

{#snippet item(card: NoticeCard, ids: string[])}
	{@const { title, body } = agencyMessage(card, locale, card.stops)}
	{@const source = agencyMessageLink(card, locale)}
	{@const periods = agencyMessagePeriods(card.periods, locale, timeZone, live)}
	<li id={ids[0] ? anchor(ids[0]) : undefined} tabindex="-1" class="min-w-0 scroll-mt-24">
		{#each ids.slice(1) as id (id)}<span id={anchor(id)} class="block scroll-mt-24"></span>{/each}
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
								{@const code = display.line(route)}
								{@const name = noticeLineName(code, display.lineName(route).name)}
								<a
									class="inline-flex min-h-11 min-w-11 items-center justify-center"
									href={localizeHref(`/lines/${encodeURIComponent(route)}`, locale, city)}
									aria-label={display.directory.spoken(name ? `${code} · ${name}` : code)}
								>
									<RoutePlate {code} />
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
					{t('Agency notice', 'Avis de la société de transport')}
				</a>
			{/if}
		</Card>
	</li>
{/snippet}

{#if cards.length}
	{#if selectedOutsideFilters}
		<ul class="alert-list">
			{@render item(selectedOutsideFilters, [target!])}
		</ul>
	{/if}
	{#if ordered.length}
		<ul bind:this={list} class="alert-list grid gap-[var(--space-card-gap)]">
			{#each ordered.slice(0, shown) as card (card.key)}
				{@render item(
					card,
					card.ids.filter((id) => anchorOwners[id] === card.key),
				)}
			{/each}
		</ul>
		<ShowMore {shown} total={ordered.length} {pageSize} {labels} onMore={showMore} />
	{:else}
		<p role="status">
			{t('No notices match these filters.', 'Aucun avis ne correspond à ces filtres.')}
		</p>
	{/if}
{:else}
	<p>{t('No notices in effect.', 'Aucun avis en vigueur.')}</p>
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
