<script lang="ts">
	import { StatusMark, type StampProps } from '@yesid/ui/brand';
	import type { Locale } from '#lib/i18n/index.ts';
	import { feedState, type CaptureTripReport } from '#lib/live/captureSnapshot.ts';
	import LiveTripReport from '#lib/live/LiveTripReport.svelte';
	import {
		clockTime,
		delayReading,
		liveDelayLabels,
		liveStampAge,
		predictedIn,
	} from '#lib/site/presenter.ts';
	import { classifyDelay } from '#lib/v1/live/statusBands.ts';
	import { nextStopPredictions } from './lineLiveReadings.ts';
	import { choose } from '../record/recordText.ts';
	import RecordCard from '../record/RecordCard.svelte';

	let {
		city,
		line,
		stops,
		seed,
		refreshed,
		now,
		locale,
		timeZone,
		stopHref,
	}: {
		city: string;
		line: string;
		stops: { id: string; name: string }[];
		seed: Promise<CaptureTripReport | null>;
		refreshed: boolean;
		now: number;
		locale: Locale;
		timeZone: string;
		stopHref: (id: string) => string;
	} = $props();
	const t = (en: string, fr: string) => choose(locale, en, fr);
	function stamp(report: CaptureTripReport | null): StampProps | undefined {
		const at = report?.feed.captured_at;
		return at && feedState(report?.feed, now) === 'live'
			? { kind: 'live', label: liveStampAge(Math.max(0, now - Date.parse(at)) / 1000, locale) }
			: undefined;
	}
</script>

{#snippet readings(report: CaptureTripReport | null)}
	{@const predictions = nextStopPredictions(report, now)}
	<RecordCard
		interactive
		title={t('Next vehicles at its main stops', 'Prochains véhicules à ses principaux arrêts')}
		stamp={stamp(report)}
	>
		<ul class="grid gap-x-6 md:grid-cols-2">
			{#each stops as stop (stop.id)}
				{@const estimate = predictions.get(stop.id)}
				<li class="grid min-w-0 content-start gap-1 border-t border-border py-2">
					<a
						class="inline-flex min-h-11 min-w-11 w-fit items-center text-primary underline"
						href={stopHref(stop.id)}>{stop.name}</a
					>
					{#if estimate}
						{@const status = classifyDelay(estimate.delay)}
						{@const scheduled =
							estimate.scheduledAt === null
								? null
								: clockTime(new Date(estimate.scheduledAt), locale, timeZone)}
						<div class="flex flex-wrap justify-between gap-x-3">
							<span class="inline-flex flex-wrap items-baseline gap-x-2"
								><StatusMark
									{status}
									label={liveDelayLabels(locale)[status]}
								/>{#if estimate.delay !== null}
									<span class="text-small text-muted-foreground"
										>{delayReading(estimate.delay, locale)}</span
									>{/if}</span
							>
							<strong class="tabular-nums">{predictedIn(estimate.predictedAt, now, locale)}</strong>
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
							{t('No current prediction for this stop.', 'Aucune prévision à jour pour cet arrêt.')}
						</p>
					{/if}
				</li>
			{/each}
		</ul>
		{#snippet evidence()}
			<p>
				{t(
					'These are the agency’s predictions, not observed arrivals.',
					'Ce sont les prévisions de l’agence, pas des arrivées observées.',
				)}
			</p>
		{/snippet}
	</RecordCard>
{/snippet}

<LiveTripReport {city} kind="line" id={line} {seed} {now} {refreshed} children={readings} />
