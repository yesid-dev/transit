<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import { captureFamily, feedState, type CaptureSnapshot } from '#lib/live/captureSnapshot.ts';
	import {
		agencyMessage,
		agencyMessagePeriods,
		sortAgencyMessages,
	} from '#lib/site/agencyMessages.ts';
	import { liveStampAge } from '#lib/site/presenter.ts';
	import { alertEffect, liveAlertCards } from '../alerts/alertCards.ts';
	import { choose } from '../record/recordText.ts';
	import RecordCard from '../record/RecordCard.svelte';

	let {
		snapshot,
		now,
		locale,
		scope,
		operator,
		tracked,
		timeZone,
		href,
	}: {
		snapshot: CaptureSnapshot | null;
		now: number;
		locale: Locale;
		scope: { kind: 'line'; id: string } | { kind: 'stop'; id: string; lines: readonly string[] };
		operator?: string;
		tracked: boolean;
		timeZone: string;
		href: string;
	} = $props();
	const t = (en: string, fr: string) => choose(locale, en, fr);
	const feed = $derived(captureFamily(snapshot, 'alerts'));
	const ready = $derived(tracked && feedState(feed, now) === 'live' && snapshot?.alerts != null);
	const stamp = $derived(
		ready && feed?.captured_at
			? {
					kind: 'live' as const,
					label: liveStampAge(Math.max(0, now - Date.parse(feed.captured_at)) / 1000, locale),
				}
			: undefined,
	);
	function appliesToScope(alert: NonNullable<CaptureSnapshot['alerts']>[number]) {
		const current = scope;
		if (current.kind === 'line') return alert.routes.includes(current.id);
		return (
			alert.stops.includes(current.id) ||
			(!alert.stops.length && alert.routes.some((route) => current.lines.includes(route)))
		);
	}
	const notices = $derived(
		ready
			? sortAgencyMessages(
					liveAlertCards(snapshot?.alerts?.filter(appliesToScope) ?? [], now),
					locale,
					(id) => id,
				).slice(0, 4)
			: [],
	);
</script>

<RecordCard
	interactive={tracked}
	title={scope.kind === 'stop'
		? t('Notices for this stop', 'Avis pour cet arrêt')
		: t('Agency notices', 'Avis de l’agence')}
	{stamp}
>
	{#if !tracked}
		<p>
			{t(
				'Agency notices are not tracked in this city.',
				'Les avis de l’agence ne sont pas suivis dans cette ville.',
			)}
		</p>
	{:else if !ready}
		<p>
			{t(
				'Live agency notices are temporarily unavailable.',
				'Les avis de l’agence en direct sont temporairement indisponibles.',
			)}
		</p>
	{:else if notices.length}
		<ul class="grid gap-4">
			{#each notices as notice (notice.id)}
				{@const { title, body } = agencyMessage(notice, locale)}
				{@const dates = agencyMessagePeriods(notice.periods, locale, timeZone, true)}
				<li class="grid gap-1">
					<h3 class="font-semibold" lang={title.lang}>{title.text}</h3>
					{#if notice.effect || dates.length}
						<p class="text-small text-muted-foreground">
							{[notice.effect ? alertEffect(notice.effect, locale) + '.' : '', ...dates]
								.filter(Boolean)
								.join(' ')}
						</p>
					{/if}
					{#if body}<p class="whitespace-pre-line" lang={body.lang}>{body.text}</p>{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<p>
			{scope.kind === 'stop' && operator
				? t(
						`${operator} has no notice in effect for this stop.`,
						`${operator} n’a aucun avis en vigueur pour cet arrêt.`,
					)
				: t(
						'No agency notices in effect for this line.',
						'Aucun avis de l’agence en vigueur pour cette ligne.',
					)}
		</p>
	{/if}
	{#snippet links()}
		{#if tracked}
			<a class="inline-flex min-h-11 items-center text-primary underline" {href}
				>{t('All alerts in effect', 'Tous les avis en vigueur')}</a
			>
		{/if}
	{/snippet}
</RecordCard>
