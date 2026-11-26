<script lang="ts">
	import { StateNotice } from '@yesid/ui/feedback';
	import type { Locale } from '#lib/i18n/index.ts';
	import { captureFamily, feedState, type CaptureSnapshot } from '#lib/live/captureSnapshot.ts';
	import {
		agencyMessage,
		agencyMessagePeriods,
		sortAgencyMessages,
	} from '#lib/site/agencyMessages.ts';
	import { page } from '$app/state';
	import { alertsNotTrackedLine, liveStampAge, officialAlertsLabel } from '#lib/site/presenter.ts';
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
	// The city's declaration names its official alerts page; Transit links to it when it does not collect them.
	const officialAlertsUrl = $derived(
		(page.data.provider as { alert_links?: Partial<Record<Locale, string>> } | null | undefined)
			?.alert_links?.[locale],
	);
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

{#snippet empty(message: string)}
	{#if scope.kind === 'stop'}
		<StateNotice title={message} presentation="row" role="status" />
	{:else}
		<p>{message}</p>
	{/if}
{/snippet}

<RecordCard
	interactive={tracked || !!officialAlertsUrl}
	title={scope.kind === 'stop'
		? t('Notices for this stop', 'Avis pour cet arrêt')
		: t('Agency notices', 'Avis de l’agence')}
	{stamp}
>
	{#if !tracked}
		{@render empty(alertsNotTrackedLine(operator ?? '', locale))}
	{:else if !ready}
		{@render empty(
			t(
				'Live agency notices are temporarily unavailable.',
				'Les avis de l’agence en direct sont temporairement indisponibles.',
			),
		)}
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
		{@render empty(
			scope.kind === 'stop' && operator
				? t(
						`${operator} has no notice in effect for this stop.`,
						`${operator} n’a aucun avis en vigueur pour cet arrêt.`,
					)
				: t(
						'No agency notices in effect for this line.',
						'Aucun avis de l’agence en vigueur pour cette ligne.',
					),
		)}
	{/if}
	{#snippet links()}
		{#if tracked}
			<a class="inline-flex min-h-11 items-center text-primary underline" {href}
				>{t('All alerts in effect', 'Tous les avis en vigueur')}</a
			>
		{:else if officialAlertsUrl}
			<a class="inline-flex min-h-11 items-center text-primary underline" href={officialAlertsUrl}
				>{officialAlertsLabel(locale)}</a
			>
		{/if}
	{/snippet}
</RecordCard>
