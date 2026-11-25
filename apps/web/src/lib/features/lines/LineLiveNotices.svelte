<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import { feedState, type CaptureSnapshot } from '#lib/live/captureSnapshot.ts';
	import {
		agencyMessageDates,
		agencyMessageHeading,
		dateAndClock,
		liveStampAge,
	} from '#lib/site/presenter.ts';
	import { alertDisplayText } from '#lib/v1/alertDisplay.ts';
	import { effectLabel } from '#lib/v1/gtfsAlertLabels.ts';
	import { choose } from '../record/recordText.ts';
	import RecordCard from '../record/RecordCard.svelte';
	import { captureFamily } from './lineLiveReadings.ts';

	let {
		snapshot,
		now,
		locale,
		line,
		tracked,
		timeZone,
		href,
	}: {
		snapshot: CaptureSnapshot | null;
		now: number;
		locale: Locale;
		line: string;
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
	const notices = $derived(
		ready
			? (snapshot?.alerts
					?.flatMap((alert) => {
						if (!alert.routes.includes(line)) return [];
						const active = alert.periods.find(
							([start, end]) =>
								(!start || Date.parse(start) <= now) && (!end || now < Date.parse(end)),
						);
						if (alert.periods.length && !active) return [];
						const message = alertDisplayText(
							{
								description: alert.description.fr,
								description_en: alert.description.en,
								header_text: alert.header.fr,
								header_text_en: alert.header.en,
								message: { description_language: 'fr', header_language: 'fr' },
							},
							locale,
						);
						const language = message.lang ?? locale;
						const { title } = agencyMessageHeading(
							{
								header: { en: null, fr: null },
								description: { en: null, fr: null, [language]: message.text },
							},
							locale,
						);
						const [start, end] = active ?? [];
						return [
							{
								id: alert.id,
								lang: message.lang,
								title,
								body: message.text.slice(title.length).trim(),
								effect: effectLabel(alert.effect, locale),
								start,
								end,
								dates: start && end ? agencyMessageDates([{ start, end }], locale, timeZone) : null,
							},
						];
					})
					.slice(0, 4) ?? [])
			: [],
	);
</script>

<RecordCard title={t('Agency notices', 'Avis de l’agence')} {stamp}>
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
				<li class="grid gap-1">
					<h3 class="font-semibold" lang={notice.lang ?? undefined}>{notice.title}</h3>
					{#if notice.effect || notice.start || notice.end}
						<p class="text-small text-muted-foreground">
							{[
								notice.effect,
								notice.dates ||
									(notice.start &&
										t(
											`Since ${dateAndClock(notice.start, locale, timeZone)}`,
											`Depuis le ${dateAndClock(notice.start, locale, timeZone)}`,
										)),
								!notice.dates &&
									notice.end &&
									t(
										`Until ${dateAndClock(notice.end, locale, timeZone)}`,
										`Jusqu’au ${dateAndClock(notice.end, locale, timeZone)}`,
									),
							]
								.filter(Boolean)
								.join(' · ')}
						</p>
					{/if}
					{#if notice.body}<p lang={notice.lang ?? undefined}>{notice.body}</p>{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<p>
			{t(
				'No agency notices in effect for this line.',
				'Aucun avis de l’agence en vigueur pour cette ligne.',
			)}
		</p>
	{/if}
	{#snippet footer()}
		{#if tracked}
			<a class="inline-flex min-h-11 items-center text-primary underline" {href}
				>{t('All alerts in effect', 'Tous les avis en vigueur')}</a
			>
		{/if}
	{/snippet}
</RecordCard>
