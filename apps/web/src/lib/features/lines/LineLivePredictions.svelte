<script lang="ts">
	import type { Awaitable } from '#lib/site/ready.ts';
	import { stopDisplayName } from '#lib/site/transitDisplay.ts';
	import { StatusMark, type StampProps } from '@yesid/ui/brand';
	import { Badge } from '@yesid/ui/badge';
	import type { Locale } from '#lib/i18n/index.ts';
	import { feedState, type CaptureTripReport } from '#lib/live/captureSnapshot.ts';
	import LiveTripReport from '#lib/live/LiveTripReport.svelte';
	import {
		clockTime,
		liveDelayLabels,
		liveStatusWords,
		tickingLiveStamp,
		predictedIn,
	} from '#lib/site/presenter.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { classifyDelay } from '#lib/v1/live/statusBands.ts';
	import { nextStopPredictions, type LineMainStop } from './lineLiveReadings.ts';
	import { choose } from '../record/recordText.ts';
	import RecordPending from '../record/RecordPending.svelte';
	import RecordCard from '../record/RecordCard.svelte';

	let {
		city,
		line,
		stops,
		headsigns,
		seed,
		refreshed,
		now,
		locale,
		timeZone,
		stopHref,
	}: {
		city: string;
		line: string;
		stops: LineMainStop[];
		headsigns: Readonly<Record<number, string>>;
		seed: Awaitable<CaptureTripReport | null>;
		refreshed: boolean;
		now: number;
		locale: Locale;
		timeZone: string;
		stopHref: (id: string) => string;
	} = $props();
	const display = transitDisplay();
	const t = (en: string, fr: string) => choose(locale, en, fr);
	function stamp(report: CaptureTripReport | null): StampProps | undefined {
		const at = report?.feed.captured_at;
		return at && feedState(report?.feed, now) === 'live'
			? tickingLiveStamp(new Date(at), locale, { now })
			: undefined;
	}
</script>

{#snippet readings(report: CaptureTripReport | null, waiting = false)}
	{@const predictions = nextStopPredictions(report, now, headsigns)}
	<RecordCard
		interactive
		title={t('Next vehicles at the main stops', 'Prochains véhicules aux principaux arrêts')}
		stamp={stamp(report)}
	>
		{#if waiting}<RecordPending
				{locale}
				shape={{ shape: 'rows', count: stops.length, lines: 2, lead: 'code', header: false }}
			/>{:else}
			<ul class="grid gap-x-(--space-card-gap) md:grid-cols-2">
				{#each stops as stop (stop.id)}
					{@const estimate = predictions.get(stop.id)}
					<li class="grid min-w-0 content-start gap-1 py-2">
						<a
							class="inline-flex min-h-11 min-w-11 w-fit max-w-full flex-wrap items-center gap-2 text-primary underline"
							href={stopHref(stop.id)}
						>
							<Badge variant="outline" class="shrink-0 font-mono">{stop.code || stop.id}</Badge>
							<span class="wrap-normal">{stopDisplayName(display.readName(stop.name, locale))}</span
							>
						</a>
						{#if estimate}
							{@const status = classifyDelay(estimate.delay)}
							{@const headsign = display.directory.headsign(line, estimate.toward)}
							{@const scheduled =
								estimate.scheduledAt === null
									? null
									: clockTime(new Date(estimate.scheduledAt), locale, timeZone)}
							<p class="text-small text-muted-foreground">
								{headsign
									? display.toward(headsign, locale)
									: t('Destination unavailable.', 'Destination indisponible.')}
							</p>
							<div class="flex flex-wrap justify-between gap-x-3">
								<span class="inline-flex flex-wrap items-baseline gap-x-2"
									><StatusMark
										{status}
										{...liveStatusWords(
											status,
											liveDelayLabels(locale)[status],
											estimate.delay,
											locale,
										)}
									/></span
								>
								<strong class="tabular-nums"
									>{predictedIn(estimate.predictedAt, now, locale)}</strong
								>
							</div>
							{#if scheduled}
								<p class="text-small text-muted-foreground">
									{t(`Scheduled ${scheduled}`, `Prévu à ${scheduled}`)}
								</p>
							{:else}
								<p class="text-small text-muted-foreground">
									{t('Scheduled time unavailable.', 'Heure prévue indisponible.')}
								</p>
							{/if}
						{:else}
							<p class="text-small text-muted-foreground">
								{t(
									'No current prediction for this stop.',
									'Aucune prévision à jour pour cet arrêt.',
								)}
							</p>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
		{#snippet evidence()}
			<p>
				{t(
					'These are the agency’s predictions, not observed arrivals.',
					'Ce sont les prévisions de la société de transport, pas des arrivées observées.',
				)}
			</p>
		{/snippet}
	</RecordCard>
{/snippet}

<LiveTripReport {city} kind="line" id={line} {seed} {now} {refreshed} children={readings}>
	{#snippet pending()}{@render readings(null, true)}{/snippet}
</LiveTripReport>
