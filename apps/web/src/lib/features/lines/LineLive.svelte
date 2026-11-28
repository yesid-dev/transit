<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { Awaitable, Ready } from '#lib/site/ready.ts';
	import { stopDisplayName } from '#lib/site/transitDisplay.ts';
	import RecordGroup from '#lib/features/record/RecordGroup.svelte';
	import RecordBandBar from '../record/charts/RecordBandBar.svelte';
	import type { Locale } from '#lib/i18n/index.ts';
	import { localizeHref } from '#lib/i18n/routing.ts';
	import LiveCapture from '#lib/live/LiveCapture.svelte';
	import {
		captureDisplayState,
		captureFamily,
		type CaptureSnapshot,
		type CaptureTripReport,
	} from '#lib/live/captureSnapshot.ts';
	import { carryFrameState } from '#lib/site/frameState.ts';
	import { page } from '$app/state';
	import {
		agencyName,
		countedUnit,
		dateAndClock,
		frenchAgency,
		liveDelayLabels,
		liveStampAge,
		tickingLiveStamp,
		lineNoVehicleSentence,
		lineVehicleSentence,
		noHeadingNote,
		scheduledClock,
	} from '#lib/site/presenter.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import type { loadLineRecord } from '#lib/server/lineRecord.ts';
	import { vehicleLiveHref } from '../vehicles/vehicleLinks.ts';
	import { choose, rateStateText, tally } from '../record/recordText.ts';
	import { chartState } from '../record/charts/recordCharts.ts';
	import { overviewCopy } from '../home/overviewRecord.copy.ts';
	import AboutLiveFigures from '../record/AboutLiveFigures.svelte';
	import RecordActionGroup from '../record/RecordActionGroup.svelte';
	import CiteBlock from '../record/CiteBlock.svelte';
	import RecordAnswer from '../record/RecordAnswer.svelte';
	import RecordCard from '../record/RecordCard.svelte';
	import RecordPending from '../record/RecordPending.svelte';
	import RecordSkeleton from '../record/RecordSkeleton.svelte';
	import LineScheduleCard from './LineScheduleCard.svelte';
	import LineMeasurementLimits from './LineMeasurementLimits.svelte';
	import LiveVehicleTable from './LiveVehicleTable.svelte';
	import LineLivePredictions from './LineLivePredictions.svelte';
	import LineLiveNotices from './LineLiveNotices.svelte';
	import {
		delayStatuses,
		firstTripAhead,
		lineSilentCount,
		lineVehicleRows,
		vehicleCounts,
		type LineMainStop,
	} from './lineLiveReadings.ts';
	import { lineTimetableOnly } from './lineRecordText.ts';
	import type { RecordMeasure } from '#lib/server/engine.ts';

	let {
		heading,
		line,
		name,
		city,
		locale,
		url,
		operator,
		timeZone,
		scheduleOnly,
		knownLine,
		tracksVehicles,
		hasAlerts,
		mainStops,
		capture,
		trips,
		record,
		stopNames,
		headsigns,
		predictionHeadsigns,
	}: {
		heading: Snippet;
		line: string;
		name: string;
		city: string;
		locale: Locale;
		url: URL;
		operator: string;
		timeZone: string;
		scheduleOnly: boolean;
		knownLine: boolean;
		tracksVehicles: boolean;
		hasAlerts: boolean;
		mainStops: LineMainStop[];
		capture: Awaitable<CaptureSnapshot | null> | null;
		trips: Awaitable<CaptureTripReport | null> | null;
		record: Ready<ReturnType<typeof loadLineRecord>> | null | undefined;
		stopNames: Record<string, string>;
		headsigns: Record<number, string>;
		predictionHeadsigns: Record<number, string>;
	} = $props();
	const labels = $derived(liveDelayLabels(locale));
	const title = $derived(choose(locale, 'Vehicles running now', 'Véhicules en service maintenant'));
	const terms = $derived(overviewCopy[locale]);
	const display = transitDisplay();
	const t = (en: string, fr: string) => choose(locale, en, fr);
	const agencyFr = $derived(frenchAgency(agencyName(operator, page.data.provider)));
	const link = (path: string) => carryFrameState(localizeHref(path, locale, city), url);
	const stopHref = (id: string) => link('/stop/' + encodeURIComponent(id));
	const share = $derived.by(() => {
		const target = new URL(url);
		target.searchParams.set('provider', city);
		target.searchParams.set('frameMode', 'live');
		return target.href;
	});
	const punctuality = $derived(
		record?.sections.find(({ section }) => section === 'punctuality')?.answer,
	);
	const boundaries = $derived(
		record?.sections.find(({ section }) => section === 'boundaries')?.answer,
	);

	function describeRows(snapshot: CaptureSnapshot | null, now: number) {
		return (
			lineVehicleRows(snapshot, line, now)?.map((row) => ({
				...row,
				href:
					tracksVehicles && row.vehicleId
						? vehicleLiveHref(row.vehicleId, url, locale, city)
						: undefined,
				destination:
					row.toward === null ? null : display.directionLabel(row.toward, headsigns, locale),
				nextStop:
					row.stop && stopNames[row.stop]
						? {
								name: stopDisplayName(display.readName(stopNames[row.stop], locale)),
								href: stopHref(row.stop),
							}
						: undefined,
			})) ?? null
		);
	}
</script>

{#snippet schedule()}
	{#if record}<LineScheduleCard {record} {locale} {url} {headsigns} />{/if}
{/snippet}

{#snippet body(
	snapshot: CaptureSnapshot | null,
	now: number,
	historical: RecordMeasure | null,
	refreshed: boolean,
	waiting = false,
)}
	{@const feed = captureFamily(snapshot, 'vehicle_positions')}
	{@const state = captureDisplayState(feed, now, snapshot?.published_at)}
	{@const rows = describeRows(snapshot, now)}
	{@const live = rows !== null && (!!rows.length || knownLine)}
	{@const counts = vehicleCounts(rows ?? [])}
	{@const bands = delayStatuses.map((status) => ({
		id: status,
		status,
		label: labels[status],
		share: counts[status],
		valueLabel: countedUnit(counts[status], 'vehicle', locale),
	}))}
	{@const capturedAt = feed?.captured_at}
	{@const age = capturedAt ? Math.max(0, now - Date.parse(capturedAt)) / 1000 : null}
	{@const stamp = capturedAt
		? tickingLiveStamp(new Date(capturedAt), locale, {
				now,
				late: state === 'stale',
				label: state === 'stale' ? liveStampAge(age, locale, 'behind') : undefined,
			})
		: undefined}
	{@const silent = lineSilentCount(snapshot, line, now)}
	{@const limits =
		historical &&
		lineTimetableOnly(historical) &&
		(!rows?.length ||
			(snapshot?.vehicle_positions
				?.filter(({ route_id }) => route_id === line)
				.every(({ trip_id }) => !trip_id) ??
				false))}
	<RecordGroup class="gap-(--space-card-gap) py-(--space-card-gap)">
		<div data-screen-intro class="min-[1280px]:-mb-4">{@render heading()}</div>
		<div id="line-detail-profile" data-slot="screen-answer" class="live-answer min-[1280px]:-mb-4">
			{#if waiting}
				<RecordPending {locale} shape="answer" liveAnswer />
			{:else if live && rows && !limits}
				{#snippet citation()}
					<CiteBlock
						{locale}
						text={[
							`${name} · ${t('Vehicle positions', 'Positions des véhicules')} · ${operator}`,
							feed?.captured_at ? dateAndClock(feed.captured_at, locale, timeZone) : '',
							share,
						]
							.filter(Boolean)
							.join(' ')}
					/>
				{/snippet}
				{#snippet actions()}<RecordActionGroup
						{locale}
						href={share}
						files={[]}
						{citation}
					/>{/snippet}
				{#if rows.length}
					<RecordAnswer
						{locale}
						value={tally(rows.length, locale)}
						sentence={lineVehicleSentence(counts, locale)}
						time={stamp}
						{actions}
					/>
				{:else}
					<!-- At zero the answer says what runs next, never a big 0. -->
					{#snippet quiet(first: string | null)}
						<RecordAnswer
							{locale}
							value={null}
							sentence={lineNoVehicleSentence(
								first === null ? null : scheduledClock(first, locale),
								locale,
							)}
							time={stamp}
							{actions}
						/>
					{/snippet}
					{#if boundaries}
						{#await boundaries}
							{@render quiet(null)}
						{:then answer}
							{@render quiet(
								firstTripAhead(
									answer.kind === 'answer' && 'cells' in answer.answer ? answer.answer : undefined,
									now,
									timeZone,
								),
							)}
						{/await}
					{:else}
						{@render quiet(null)}
					{/if}
				{/if}
			{:else if limits && historical}
				{#snippet reason()}<p>
						{historical.coverage_note?.[locale] ??
							t(
								'There are no usable observations for this line on these dates. Its timetable is shown below.',
								'Il n’y a pas d’observations utilisables pour cette ligne à ces dates. Son horaire est présenté ci-dessous.',
							)}
					</p>{/snippet}
				<RecordAnswer
					{locale}
					value={null}
					state={chartState(historical.state)}
					sentence={rateStateText(historical, locale)}
					meta={reason}
				/>
			{:else}
				<RecordAnswer
					{locale}
					value={null}
					state={state === 'stale' ? 'not_reporting' : 'no_live_data'}
					time={stamp}
					sentence={state === 'stale'
						? t(
								'Vehicle positions are out of date.',
								'Les positions des véhicules ne sont plus à jour.',
							)
						: t(
								'Live vehicle positions are temporarily unavailable.',
								'Les positions des véhicules en direct sont temporairement indisponibles.',
							)}
				/>
			{/if}
		</div>
		{#if !limits}
			<div id="line-detail-live" class="min-w-0">
				<RecordCard interactive {title} {stamp}>
					{#if waiting}
						<RecordSkeleton shape="bands" />
						<RecordPending {locale} shape={{ shape: 'rows', count: 3, lines: 1, lead: 'none' }} />
					{:else if rows?.length}
						<div class="mb-4">
							<RecordBandBar
								label={bands.map(({ label, valueLabel }) => `${label}, ${valueLabel}`).join('. ')}
								{bands}
							/>
						</div>
						<LiveVehicleTable
							{rows}
							{locale}
							{now}
							{title}
							noHeading={rows.some(({ toward }) => toward !== null)
								? undefined
								: noHeadingNote(
										agencyName(operator, page.data.provider),
										locale,
										rows.every(({ stop }) => stop === null),
									)}
						/>
					{:else if live}
						<p>
							{t(
								'No vehicles are reporting on this line.',
								'Aucun véhicule ne transmet sa position sur cette ligne.',
							)}
						</p>
					{:else}
						<p>
							{t(
								'Live vehicle positions are temporarily unavailable.',
								'Les positions des véhicules en direct sont temporairement indisponibles.',
							)}
						</p>
					{/if}
					{#snippet evidence()}
						{#if silent !== null}
							<p>{terms.silent}{t(': ', ' : ')}{tally(silent, locale)}</p>
						{/if}
					{/snippet}
				</RecordCard>
			</div>
		{/if}
		{#if !limits && trips && mainStops.length}
			<div id="line-detail-directions">
				<LineLivePredictions
					{city}
					{line}
					stops={mainStops}
					headsigns={predictionHeadsigns}
					seed={trips}
					{refreshed}
					{now}
					{locale}
					{timeZone}
					{stopHref}
				/>
			</div>
		{/if}
	</RecordGroup>
	<RecordGroup class="gap-(--space-card-gap) py-(--space-card-gap)">
		{#if !limits}
			<div id="alerts">
				<LineLiveNotices
					scope={{ kind: 'line', id: line }}
					{snapshot}
					{now}
					{locale}
					{timeZone}
					{operator}
					{stopNames}
					pending={waiting && hasAlerts}
					tracked={hasAlerts}
					href={link('/alerts?frameMode=live&' + new URLSearchParams({ route: line }))}
				/>
			</div>
		{/if}
		{@render schedule()}
	</RecordGroup>
	<RecordGroup class="gap-(--space-card-gap) py-(--space-card-gap)">
		{#if limits}
			<LineMeasurementLimits {locale} methodHref={link('/metrics')} scheduleOnly={false} />
		{:else}
			<AboutLiveFigures
				{locale}
				{operator}
				healthLink={link('/status?frameMode=live')}
				captureAge={age}
			/>
		{/if}
	</RecordGroup>
{/snippet}

<div data-slot="screen-content" class="min-w-0">
	{#if scheduleOnly}
		<RecordGroup class="gap-(--space-card-gap) py-(--space-card-gap)">
			<div data-screen-intro class="min-[1280px]:-mb-4">{@render heading()}</div>
			<div id="line-detail-profile" data-slot="screen-answer" class="min-[1280px]:-mb-4">
				{#snippet message()}
					<p>
						{t(
							`${operator} publishes no realtime feed for this line. Its timetable is shown below.`,
							`${agencyFr.start} ne publie pas de flux en temps réel pour cette ligne. Son horaire est présenté ci-dessous.`,
						)}
					</p>
				{/snippet}
				<RecordAnswer
					{locale}
					value={null}
					state="no_live_data"
					sentence={t('No live data for this line', 'Aucune donnée en direct pour cette ligne')}
					meta={message}
				/>
			</div>
			{@render schedule()}
		</RecordGroup>
		<RecordGroup class="gap-(--space-card-gap) py-(--space-card-gap)"
			><LineMeasurementLimits {locale} methodHref={link('/metrics')} /></RecordGroup
		>
	{:else if capture}
		<LiveCapture {city} {capture}>
			{#snippet pending()}
				{@render body(null, 0, null, false, true)}
			{/snippet}
			{#snippet children(snapshot, now, refreshed)}
				{#if lineVehicleRows(snapshot, line, now) && punctuality && !snapshot?.vehicle_positions?.some(({ route_id, trip_id }) => route_id === line && trip_id)}
					{#await punctuality}
						{@render body(snapshot, now, null, refreshed, true)}
					{:then result}
						{@render body(
							snapshot,
							now,
							result.kind === 'answer' && 'value' in result.answer ? result.answer : null,
							refreshed,
						)}
					{/await}
				{:else}
					{@render body(snapshot, now, null, refreshed)}
				{/if}
			{/snippet}
		</LiveCapture>
	{:else}
		{@render body(null, Date.now(), null, false)}
	{/if}
</div>

<style>
	@media (width >= 80rem) {
		/* One reading row, with the same room for delayed status as the waiting view. */
		.live-answer {
			min-block-size: 5.125rem;
		}
	}
</style>
