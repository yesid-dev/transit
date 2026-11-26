<script lang="ts">
	import { StateNotice } from '@yesid/ui/feedback';
	import type { Locale } from '#lib/i18n/index.ts';
	import { captureFamily, feedState, type CaptureSnapshot } from '#lib/live/captureSnapshot.ts';
	import { sortAgencyMessages } from '#lib/site/agencyMessages.ts';
	import { page } from '$app/state';
	import {
		agencyName,
		alertsNotTrackedLine,
		liveStampAge,
		noLiveStopNotices,
		noticesForLines,
		officialAlertsLabel,
	} from '#lib/site/presenter.ts';
	import type { PublicCity } from '#lib/v1/schemas/providers.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { groupAlertCards, liveAlertCards, type NoticeCard } from '../alerts/alertCards.ts';
	import NoticeRows from '../alerts/NoticeRows.svelte';
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
		stopNames = {},
	}: {
		snapshot: CaptureSnapshot | null;
		now: number;
		locale: Locale;
		scope: { kind: 'line'; id: string } | { kind: 'stop'; id: string; lines: readonly string[] };
		operator?: string;
		tracked: boolean;
		timeZone: string;
		href: string;
		stopNames?: Readonly<Record<string, string>>;
	} = $props();
	const t = (en: string, fr: string) => choose(locale, en, fr);
	// The city's declaration names its official alerts page; Transit links to it when it does not collect them.
	const city = $derived(page.data.provider as PublicCity | null | undefined);
	const display = transitDisplay();
	const agency = $derived(agencyName(operator ?? '', city));
	const stopName = (id: string) => (stopNames[id] ? display.readName(stopNames[id], locale) : id);
	const officialAlertsUrl = $derived(city?.alert_links?.[locale]);
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
	const cards = $derived(ready ? liveAlertCards(snapshot?.alerts ?? [], now) : []);
	const notices = $derived(
		sortAgencyMessages(
			groupAlertCards(
				cards.filter((card) =>
					scope.kind === 'line' ? card.routes.includes(scope.id) : card.stops.includes(scope.id),
				),
			),
			locale,
			display.line,
		).slice(0, 4),
	);
	const related = $derived.by(() => {
		if (scope.kind !== 'stop') return [];
		const { id, lines } = scope;
		const groups: Record<string, { lines: string[]; notices: NoticeCard[] }> = Object.create(null);
		for (const notice of sortAgencyMessages(
			groupAlertCards(
				cards.filter(
					(card) => !card.stops.includes(id) && card.routes.some((route) => lines.includes(route)),
				),
			),
			locale,
			display.line,
		)) {
			const affected = lines.filter((line) => notice.routes.includes(line)).map(display.line);
			const key = JSON.stringify(affected);
			const group = groups[key];
			if (group) group.notices.push(notice);
			else groups[key] = { lines: affected, notices: [notice] };
		}
		return Object.values(groups);
	});
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
		: t('Agency notices', 'Avis de la société de transport')}
	{stamp}
>
	{#if !tracked}
		{@render empty(alertsNotTrackedLine(agency, locale))}
	{:else if !ready}
		{@render empty(
			t(
				'Live agency notices are temporarily unavailable.',
				'Les avis en direct de la société de transport sont temporairement indisponibles.',
			),
		)}
	{:else if notices.length}
		<NoticeRows cards={notices} {locale} {timeZone} {stopName} live />
	{:else}
		{@render empty(
			scope.kind === 'stop' && operator
				? noLiveStopNotices(agency, locale)
				: t(
						'No agency notices in effect for this line.',
						'Aucun avis de la société de transport en vigueur pour cette ligne.',
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

{#each related as group (group.lines.join(','))}
	<RecordCard title={noticesForLines(group.lines, locale)} {stamp}>
		<NoticeRows cards={group.notices.slice(0, 4)} {locale} {timeZone} {stopName} live />
	</RecordCard>
{/each}
