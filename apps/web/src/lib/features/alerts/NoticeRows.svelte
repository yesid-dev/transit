<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import { agencyMessage, agencyMessagePeriods } from '#lib/site/agencyMessages.ts';
	import { alertEffect, type AlertCard } from './alertCards.ts';

	let {
		cards,
		locale,
		timeZone,
		stopName,
		live = false,
	}: {
		cards: readonly AlertCard[];
		locale: Locale;
		timeZone?: string;
		stopName: (id: string) => string;
		live?: boolean;
	} = $props();
</script>

<ul class="grid gap-4">
	{#each cards as notice (notice.key)}
		{@const { title, body } = agencyMessage(notice, locale, notice.stops, stopName)}
		{@const dates = agencyMessagePeriods(notice.periods, locale, timeZone, live)}
		<li class="grid gap-1">
			<h3 class="wrap-break-word font-semibold" lang={title.lang}>{title.text}</h3>
			{#if notice.effect || dates.length}
				<p class="text-small text-muted-foreground">
					{[notice.effect ? alertEffect(notice.effect, locale) + '.' : '', ...dates]
						.filter(Boolean)
						.join(' ')}
				</p>
			{/if}
			{#if notice.stops.length > 1}
				<p class="text-small text-muted-foreground">
					{locale === 'fr' ? 'Arrêts\u00a0:' : 'Stops:'}
					{notice.stops.map(stopName).join(' · ')}
				</p>
			{/if}
			{#if body}<p class="wrap-break-word whitespace-pre-line" lang={body.lang}>{body.text}</p>{/if}
		</li>
	{/each}
</ul>
