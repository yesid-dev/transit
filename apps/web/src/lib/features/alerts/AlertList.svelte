<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { RoutePlate } from '@yesid/ui/brand';
	import { Button } from '@yesid/ui/button';
	import { ShowMore } from '@yesid/ui/table';
	import { tick } from 'svelte';
	import { SvelteURL } from 'svelte/reactivity';
	import type { Locale } from '#lib/i18n/index.ts';
	import { choose } from '#lib/features/record/recordText.ts';
	import { localizeHref } from '#lib/i18n/routing.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { alertPeriod, alertPaging } from '#lib/site/presenter.ts';
	import StateMark from '#lib/features/record/StateMark.svelte';
	import {
		agencyText,
		alertAgencyLink,
		alertEffect,
		alertTarget,
		genericAgencyHeading,
		type AlertCard,
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
	const display = transitDisplay();
	const t = (en: string, fr: string) => choose(locale, en, fr);
	const location = $derived(page.shallow?.url ?? page.url);
	const line = $derived(location.searchParams.get('route') ?? '');
	const selectedEffect = $derived(live ? (location.searchParams.get('effect') ?? '') : '');
	const effectKey = (card: AlertCard) => card.effect ?? 'UNKNOWN_EFFECT';
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
	const filters = $derived(
		Array.from(location.searchParams).filter(
			([key]) => key !== 'route' && (!live || key !== 'effect') && key !== 'alert',
		),
	);
	const target = $derived(alertTarget(new URL(location.href)));
	const filtered = $derived(
		cards.filter(
			(card) =>
				(!line || card.routes.includes(line)) &&
				(!selectedEffect || effectKey(card) === selectedEffect),
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

	let paging = $state<{ line: string; effect: string; shown: number }>();
	const shown = $derived(
		Math.min(
			ordered.length,
			paging?.line === line && paging.effect === selectedEffect ? paging.shown : pageSize,
		),
	);
	const labels = $derived(alertPaging(locale));

	let list = $state<HTMLUListElement>();
	let lastJump: string | null = null;
	const anchor = (id: string) => `alert-${id}`;

	$effect(() => {
		if (!target) lastJump = null;
		if (target && target !== lastJump && cards.some(({ id }) => id === target)) {
			lastJump = target;
			void tick().then(() => document.getElementById(anchor(target))?.scrollIntoView());
		}
	});

	async function showMore(count: number) {
		const previous = shown;
		paging = { line, effect: selectedEffect, shown: shown + count };
		await tick();
		(list?.children[previous] as HTMLElement | undefined)?.focus();
	}

	function apply(event: SubmitEvent) {
		event.preventDefault();
		const url = new SvelteURL(location.href);
		const values = new FormData(event.currentTarget as HTMLFormElement);
		for (const key of live ? ['route', 'effect'] : ['route']) {
			const value = values.get(key);
			if (typeof value === 'string' && value) url.searchParams.set(key, value);
			else url.searchParams.delete(key);
		}
		url.searchParams.delete('alert');
		url.hash = '';
		paging = undefined;
		void goto(url, { shallow: true, state: { ...page.state } });
	}
</script>

{#snippet item(card: AlertCard, anchorId: string | undefined)}
	{@const title = agencyText(card.header, locale)}
	{@const generic = genericAgencyHeading(title?.text)}
	{@const description = agencyText(card.description, locale)}
	{@const source = alertAgencyLink(card, locale)}
	<li
		id={anchorId}
		tabindex="-1"
		class="min-w-0 scroll-mt-24 border-b border-border py-2 last:border-b-0"
	>
		<div class="flex flex-wrap items-center gap-x-3">
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
			<h3 class="min-w-0 wrap-break-word font-semibold" lang={generic ? undefined : title?.lang}>
				{(!generic && title?.text) || t(`Alert ${card.id}`, `Avis ${card.id}`)}
			</h3>
		</div>
		<div class="flex flex-wrap items-center gap-x-3 text-small text-muted-foreground">
			{#if card.effect}
				<p>{alertEffect(card.effect, locale)}.</p>
			{:else}
				<p>
					<span class="sr-only">{t('Effect', 'Effet')} </span><StateMark state="unknown" {locale} />
				</p>
			{/if}
			{#each card.periods as period, index (index)}
				{@const text = alertPeriod(period, locale, timeZone, live)}
				{#if text}<p>{text}</p>{/if}
			{/each}
			{#if card.stops.length}
				<div class="flex flex-wrap items-center gap-x-1">
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
		</div>
		{#if generic}<p class="mt-1 font-semibold" lang={title?.lang}>{title?.text}</p>{/if}
		{#if description}<p
				class="mt-1 max-w-[var(--measure-body)] wrap-break-word whitespace-pre-line"
				lang={description.lang}
			>
				{description.text}
			</p>{/if}
		{#if source}
			<a
				class="inline-flex min-h-11 items-center text-primary underline"
				href={source.href}
				hreflang={source.lang}
			>
				{t('Agency notice', 'Avis de l’agence')}
			</a>
		{/if}
	</li>
{/snippet}

{#if cards.length}
	<search>
		<form
			method="GET"
			action={page.url.pathname}
			onsubmit={apply}
			class="flex flex-wrap items-end gap-3"
		>
			{#each filters as [key, value], index (index)}<input
					type="hidden"
					name={key}
					{value}
				/>{/each}
			{#if live}
				<label class="grid min-w-0 max-w-full gap-1 text-small">
					{t('Effect', 'Effet')}
					<select
						name="effect"
						value={selectedEffect}
						class="min-h-11 w-full max-w-full rounded-md border border-border bg-background px-2 text-base"
					>
						<option value="">{t('All effects', 'Tous les effets')}</option>
						{#each selectedEffect && !effects.includes(selectedEffect) ? [...effects, selectedEffect] : effects as key (key)}
							<option value={key}>{alertEffect(key, locale)}</option>
						{/each}
					</select>
				</label>
			{/if}
			<label class="grid min-w-0 max-w-full gap-1 text-small">
				{t('Line', 'Ligne')}
				<select
					name="route"
					value={line}
					class="min-h-11 w-full max-w-full rounded-md border border-border bg-background px-2 text-base"
				>
					<option value="">{t('All lines', 'Toutes les lignes')}</option>
					{#each line && !lines.includes(line) ? [...lines, line] : lines as key (key)}
						<option value={key}>{display.lineName(key).label}</option>
					{/each}
				</select>
			</label>
			<Button type="submit" variant="outline" class="min-h-11 min-w-11"
				>{t('Filter alerts', 'Filtrer les avis')}</Button
			>
		</form>
	</search>
	{#if selectedOutsideFilters}
		<ul class="mt-2">{@render item(selectedOutsideFilters, anchor(selectedOutsideFilters.id))}</ul>
	{/if}
	{#if ordered.length}
		<ul bind:this={list} class="mt-2">
			{#each ordered.slice(0, shown) as card, index (card.key)}
				{@render item(
					card,
					ordered.findIndex(({ id }) => id === card.id) === index ? anchor(card.id) : undefined,
				)}
			{/each}
		</ul>
		<ShowMore {shown} total={ordered.length} {pageSize} {labels} onMore={showMore} />
	{:else}
		<p class="mt-3">
			{t('No alerts match these filters.', 'Aucun avis ne correspond à ces filtres.')}
		</p>
	{/if}
{:else}
	<p>{t('No alerts in effect.', 'Aucun avis en vigueur.')}</p>
{/if}
