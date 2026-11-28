<script lang="ts">
	import type { Awaitable } from '#lib/site/ready.ts';
	import type { Snippet } from 'svelte';
	import './stopCards.css';
	import { page } from '$app/state';
	import { localizeHref, type Locale } from '#lib/i18n/index.ts';
	import LiveCapture from '#lib/live/LiveCapture.svelte';
	import LiveTripReport from '#lib/live/LiveTripReport.svelte';
	import {
		feedState,
		type CaptureSnapshot,
		type CaptureTripReport,
	} from '#lib/live/captureSnapshot.ts';
	import type { ScheduleEdition } from '#lib/search/searchIndex.ts';
	import { carryFrameState } from '#lib/site/frameState.ts';
	import {
		agencyName,
		noHeadingNote,
		singularCount,
		clockTime,
		minuteReading,
		liveStampAge,
		tickingLiveStamp,
		relativeReportAge,
		stopNextVehicleSentence,
	} from '#lib/site/presenter.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import LineLiveNotices from '../lines/LineLiveNotices.svelte';
	import AboutLiveFigures from '../record/AboutLiveFigures.svelte';
	import RecordAnswer from '../record/RecordAnswer.svelte';
	import RecordGroup from '../record/RecordGroup.svelte';
	import RecordCard from '../record/RecordCard.svelte';
	import RecordPending from '../record/RecordPending.svelte';
	import StateMark from '../record/StateMark.svelte';
	import type { RecordWaiting } from '../record/recordWaiting.ts';
	import { choose, tally } from '../record/recordText.ts';
	import StopPredictionTable from './StopPredictionTable.svelte';
	import { stopErrorLink } from './stops.copy.ts';
	import { riderToward, stopLiveReadings, type StopPrediction } from './stopLiveReadings.ts';
	import type { LinePattern } from '#lib/site/linePatterns.ts';

	let {
		id,
		lines,
		name,
		operator,
		locale,
		city,
		url,
		timeZone,
		directions,
		patterns,
		capture,
		trips,
		scheduleOnly,
		tripUpdatesPublished,
		hasAlerts,
		heading,
	}: {
		id: string;
		lines: readonly string[];
		name: string;
		operator: string;
		locale: Locale;
		city: string;
		url: URL;
		timeZone: string;
		directions?: ScheduleEdition['route_directions'];
		/** Termini of this stop's lines, so a compass headsign names where the vehicle goes. */
		patterns?: Readonly<Record<string, LinePattern>>;
		capture: Awaitable<CaptureSnapshot | null> | null;
		trips: Awaitable<CaptureTripReport | null> | null;
		scheduleOnly: boolean;
		tripUpdatesPublished: boolean;
		hasAlerts: boolean;
		heading: Snippet;
	} = $props();
	const t = (en: string, fr: string) => choose(locale, en, fr);
	const title = $derived(t('Next vehicles at this stop', 'Prochains véhicules à cet arrêt'));
	const link = (path: string) => carryFrameState(localizeHref(path, locale, city), url);
	const display = transitDisplay();
	const predictionPageSize = 6;
	const predictionsShape = {
		shape: 'rows',
		count: predictionPageSize,
		lines: 2,
	} satisfies RecordWaiting;
	const noticeShape = { shape: 'notice', count: 1 } satisfies RecordWaiting;
	function nextSentence(row: StopPrediction) {
		return stopNextVehicleSentence(
			{
				line: row.line ? display.line(row.line) : null,
				toward: riderToward(display, row, locale, 'sentence', patterns),
				scheduled:
					row.scheduledAt === null ? null : clockTime(new Date(row.scheduledAt), locale, timeZone),
			},
			locale,
		);
	}
</script>

{#snippet pending()}
	{@render content(null, null, 0, true)}
{/snippet}

{#snippet content(
	snapshot: CaptureSnapshot | null,
	report: CaptureTripReport | null,
	now: number,
	waiting = false,
)}
	{@const feed = feedState(report?.feed, now)}
	{@const readings =
		report && feed === 'live' ? stopLiveReadings(report, id, now, directions) : null}
	{@const time = report?.feed.captured_at ? Date.parse(report.feed.captured_at) : null}
	{@const age = time === null ? null : Math.max(0, now - time) / 1000}
	{@const stamp =
		time === null
			? undefined
			: tickingLiveStamp(new Date(time), locale, {
					now,
					late: feed !== 'live',
					label: feed !== 'live' ? liveStampAge(age, locale, 'behind') : undefined,
				})}
	<RecordGroup class="gap-[var(--space-card-gap)]">
		<div data-screen-intro>{@render heading()}</div>
		<div id="stop-detail-departures" class="stop-live-answer" data-slot="screen-answer">
			{#if waiting}
				<RecordPending {locale} shape="reading" />
			{:else if readings?.count}
				<RecordAnswer
					{locale}
					value={tally(readings.count, locale)}
					sentence={singularCount(readings.count, locale)
						? t(
								'vehicle is expected here in the next 15 minutes.',
								'véhicule est attendu ici dans les 15 prochaines minutes.',
							)
						: t(
								'vehicles are expected here in the next 15 minutes.',
								'véhicules sont attendus ici dans les 15 prochaines minutes.',
							)}
					time={stamp}
				/>
			{:else if readings?.rows.length}
				<!-- At zero the answer is the next vehicle, never a big 0. -->
				<RecordAnswer
					{locale}
					value={minuteReading(
						Math.max(0, Math.ceil((readings.rows[0].predictedAt - now) / 60_000)),
						locale,
					)}
					sentence={nextSentence(readings.rows[0])}
					time={stamp}
				/>
			{:else}
				<RecordAnswer
					{locale}
					value={null}
					time={stamp}
					state={feed === 'stale'
						? 'not_reporting'
						: !tripUpdatesPublished
							? 'not_tracked'
							: 'no_live_data'}
					sentence={scheduleOnly
						? t(
								'Only timetable data is published for the lines serving this stop.',
								'Seuls les horaires sont publiés pour les lignes qui desservent cet arrêt.',
							)
						: !tripUpdatesPublished
							? t(
									'This network does not publish live trip updates.',
									'Ce réseau ne publie pas de mises à jour des trajets en direct.',
								)
							: feed === 'stale'
								? t(
										'Live predictions for this stop are out of date.',
										'Les prévisions en direct pour cet arrêt ne sont plus à jour.',
									)
								: readings
									? t('No vehicle is predicted now.', 'Aucun véhicule n’est annoncé en ce moment.')
									: t(
											'Live predictions for this stop are temporarily unavailable.',
											'Les prévisions en direct pour cet arrêt sont temporairement indisponibles.',
										)}
				/>
			{/if}
		</div>
		<div class="min-w-0" data-slot="stop-live-predictions">
			<RecordCard
				{title}
				{stamp}
				reserve={waiting || readings?.rows.length ? predictionsShape : undefined}
				interactive={!!readings?.rows.some(({ line }) => line !== null) ||
					(readings?.rows.length ?? 0) > predictionPageSize}
			>
				{#if waiting}
					<RecordPending {locale} shape={predictionsShape} />
				{:else if readings?.rows.length}
					<StopPredictionTable
						rows={readings.rows}
						pageSize={predictionPageSize}
						caption={title}
						{locale}
						{city}
						{url}
						{timeZone}
						{now}
						{patterns}
					/>
				{:else}
					<StateMark
						{locale}
						state={feed === 'stale'
							? 'not_reporting'
							: !tripUpdatesPublished
								? 'not_tracked'
								: 'no_live_data'}
					/>
				{/if}
				{#snippet evidence()}
					{#if readings?.rows.length}<p class="text-small text-muted-foreground">
							{t(
								'A prediction is the agency’s estimate.',
								'Une prévision est une estimation de la société de transport.',
							)}
							{#if readings.rows.some(({ delay }) => delay === null)}{t(
									'“Delay unknown” means the feed does not give a usable delay for this stop.',
									'« Retard inconnu » signifie que le flux ne donne pas de retard exploitable pour cet arrêt.',
								)}{/if}
							{t(
								'Trips with no prediction are not listed.',
								'Les trajets sans prévision ne sont pas affichés.',
							)}
							{#if !readings.rows.some(({ toward }) => toward)}{noHeadingNote(
									agencyName(operator, page.data.provider),
									locale,
								)}{/if}
						</p>{/if}
				{/snippet}
			</RecordCard>
		</div>
	</RecordGroup>
	<RecordGroup class="gap-[var(--space-card-gap)]">
		<div
			id="stop-detail-notices"
			data-testid="stop-alerts"
			class="grid min-w-0 gap-[var(--space-card-gap)]"
		>
			{#if waiting && hasAlerts}
				<RecordCard title={t('Notices for this stop', 'Avis pour cet arrêt')}>
					<RecordPending {locale} shape={noticeShape} />
				</RecordCard>
			{:else}
				<LineLiveNotices
					{snapshot}
					{now}
					{locale}
					{timeZone}
					{operator}
					stopNames={{ [id]: name }}
					scope={{ kind: 'stop', id, lines }}
					tracked={hasAlerts}
					href={link('/alerts?frameMode=live')}
				/>
			{/if}
		</div>
	</RecordGroup>
	<RecordGroup class="gap-[var(--space-card-gap)]">
		<div id="stop-detail-facts">
			<AboutLiveFigures
				{locale}
				{operator}
				healthLink={link('/status?frameMode=live')}
				additionalFields={[
					{
						key: 'feedback',
						label: stopErrorLink[locale].label,
						text: null,
						link: { href: link('/metrics#about-transit'), label: stopErrorLink[locale].title },
					},
				]}
				scope={t(
					'Agency predictions for this stop. The count includes trips expected here in the next 15 minutes.',
					'Prévisions de la société de transport pour cet arrêt. Le décompte couvre les trajets attendus ici dans les 15 prochaines minutes.',
				)}
				statusLabel={t(
					'How a prediction gets its status',
					'Comment est déterminé l’état d’une prévision',
				)}
				definition={t(
					'From the predicted delay at this stop: early is more than 1 minute ahead, late is more than 5 minutes behind, and on time is between those limits.',
					'Selon le retard prévu à cet arrêt : en avance signifie plus d’une minute avant l’heure prévue, en retard signifie plus de 5 minutes après, et à l’heure se situe entre ces seuils.',
				)}
				captureText={waiting
					? ''
					: age === null
						? t('Trip updates unavailable.', 'Mises à jour des trajets indisponibles.')
						: t(
								`Trip updates: ${relativeReportAge(age, locale)}.`,
								`Mises à jour des trajets : ${relativeReportAge(age, locale)}.`,
							)}
			/>
		</div>
	</RecordGroup>
{/snippet}

<div class="stop-cards min-w-0" data-slot="screen-content">
	{#if capture}
		<LiveCapture {city} {capture} {pending}>
			{#snippet children(snapshot, now, refreshed)}
				{#if trips}
					<LiveTripReport {city} kind="stop" {id} seed={trips} {now} {refreshed} {pending}>
						{#snippet children(report)}
							{@render content(snapshot, report, now)}
						{/snippet}
					</LiveTripReport>
				{:else}
					{@render content(snapshot, null, now)}
				{/if}
			{/snippet}
		</LiveCapture>
	{:else}
		{@render content(null, null, Date.now())}
	{/if}
</div>
