<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { Locale } from '#lib/i18n/index.ts';
	import {
		agencyMessage,
		agencyMessagePeriods,
		agencyMessagePreview,
	} from '#lib/site/agencyMessages.ts';
	import { alertEffect, type AlertCard } from './alertCards.ts';

	let {
		notice,
		locale,
		timeZone,
		excerpt = false,
		live = false,
		routes,
		stops,
	}: {
		notice: AlertCard;
		locale: Locale;
		timeZone?: string;
		excerpt?: boolean;
		live?: boolean;
		routes: Snippet;
		stops: Snippet;
	} = $props();

	const message = $derived(agencyMessage(notice, locale, notice.stops));
	const periods = $derived(agencyMessagePeriods(notice.periods, locale, timeZone, live));
</script>

{#snippet heading()}
	<h3 class={['font-semibold', !excerpt && 'wrap-break-word']} lang={message.title.lang}>
		{message.title.text}
	</h3>
{/snippet}

{#snippet details()}
	{#if periods.length || (!excerpt && notice.effect)}
		<p
			class={['text-muted-foreground', !excerpt && 'wrap-break-word text-small']}
			data-slot={excerpt ? 'agency-message-dates' : undefined}
		>
			{#if !excerpt && notice.effect}{alertEffect(notice.effect, locale)}.
			{/if}
			{periods.join(live ? ' ' : ' · ')}
		</p>
	{/if}
{/snippet}

{#snippet description()}
	{#if message.body}
		<p
			class={excerpt
				? 'text-muted-foreground print:hidden'
				: 'mt-1 max-w-[var(--measure-body)] wrap-break-word whitespace-pre-line'}
			lang={message.body.lang}
		>
			{excerpt ? agencyMessagePreview(message.body) : message.body.text}
		</p>
	{/if}
{/snippet}

{#if excerpt}
	{@render routes()}
	<!-- One order on every notice: title, dates, then stops. -->
	<div class="min-w-0">
		{@render heading()}
		{@render details()}
		{@render stops()}
		{@render description()}
	</div>
{:else}
	<div class="min-w-0">
		<div
			class="flex flex-wrap items-center gap-x-3"
			class:single-plate={notice.routes.length === 1}
		>
			{@render routes()}
			<div class="min-w-0">
				{@render heading()}
				{@render details()}
			</div>
		</div>
		{@render stops()}
		{@render description()}
	</div>
{/if}

<style>
	@container (inline-size >= 12rem) {
		.single-plate {
			display: grid;
			grid-template-columns: auto minmax(0, 1fr);
		}
	}
</style>
