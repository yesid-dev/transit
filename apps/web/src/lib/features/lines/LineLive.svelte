<script lang="ts">
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
	import {
		countedUnit,
		dateAndClock,
		liveDelayLabels,
		liveStampAge,
		lineNoVehicleSentence,
		lineVehicleSentence,
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
		capture: Promise<CaptureSnapshot | null> | null;
		trips: Promise<CaptureTripReport | null> | null;
		record: ReturnType<typeof loadLineRecord> | null | undefined;
		stopNames: Record<string, string>;
		headsigns: Record<number, string>;
		predictionHeadsigns: Record<number, string>;
	} = $props();
	const labels = $derived(liveDelayLabels(locale));
	const title = $derived(choose(locale, 'Its vehicles now', 'Ses véhicules en ce moment'));
	const terms = $derived(overviewCopy[locale]);
	const display = transitDisplay();
	const t = (en: string, fr: string) => choose(locale, en, fr);
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

{#snippet checking()}
	<div id="line-detail-profile" data-slot="screen-answer">
		<p role="status">
			{t('Checking live reports…', 'Vérification des signalements en direct…')}
		</p>
	</div>
{/snippet}

{#snippet schedule()}
	{#if record}<LineScheduleCard {record} {locale} {url} {headsigns} />{/if}
{/snippet}

{#snippet body(
	snapshot: CaptureSnapshot | null,
	now: number,
	historical: RecordMeasure | null,
	refreshed: boolean,
)}
	{@const feed = captureFamily(snapshot, 'vehicle_positions')}
	{@const state = captureDisplayState(feed, now)}
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
	{@const age = feed?.captured_at ? Math.max(0, now - Date.parse(feed.captured_at)) / 1000 : null}
	{@const stamp =
		age === null
			? undefined
			: {
					kind: 'live' as const,
					label: liveStampAge(age, locale, state === 'stale' ? 'behind' : 'current'),
					late: state === 'stale',
				}}
	{@const silent = lineSilentCount(snapshot, line, now)}
	{@const limits =
		historical &&
		lineTimetableOnly(historical) &&
		(!rows?.length ||
			(snapshot?.vehicle_positions
				?.filter(({ route_id }) => route_id === line)
				.every(({ trip_id }) => !trip_id) ??
				false))}
	<RecordGroup>
		<div id="line-detail-profile" data-slot="screen-answer">
			{#if live && rows && !limits}
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
		{#if live && rows && !limits}
			<div id="line-detail-live" class="min-w-0">
				<RecordCard interactive {title} {stamp}>
					{#if rows.length}
						<div class="mb-4">
							<RecordBandBar
								label={bands.map(({ label, valueLabel }) => `${label}, ${valueLabel}`).join('. ')}
								{bands}
							/>
						</div>
						<LiveVehicleTable {rows} {locale} {now} {title} />
					{:else}
						<p>
							{t(
								'No vehicles are reporting on this line.',
								'Aucun véhicule ne transmet sa position sur cette ligne.',
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
	<RecordGroup>
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
					tracked={hasAlerts}
					href={link('/alerts?frameMode=live&' + new URLSearchParams({ route: line }))}
				/>
			</div>
		{/if}
		{@render schedule()}
	</RecordGroup>
	<RecordGroup>
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
		<RecordGroup>
			<div id="line-detail-profile" data-slot="screen-answer">
				{#snippet message()}
					<p>
						{t(
							`${operator} publishes no realtime feed for this line. Its timetable is shown below.`,
							`${operator} ne publie pas de flux en temps réel pour cette ligne. Son horaire est présenté ci-dessous.`,
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
		<RecordGroup><LineMeasurementLimits {locale} methodHref={link('/metrics')} /></RecordGroup>
	{:else if capture}
		<LiveCapture {city} {capture}>
			{#snippet pending()}
				<RecordGroup waiting="answer">
					{@render checking()}
					{@render schedule()}
				</RecordGroup>
			{/snippet}
			{#snippet children(snapshot, now, refreshed)}
				{#if lineVehicleRows(snapshot, line, now) && punctuality && !snapshot?.vehicle_positions?.some(({ route_id, trip_id }) => route_id === line && trip_id)}
					{#await punctuality}
						<RecordGroup waiting="answer">
							{@render checking()}
							{@render schedule()}
						</RecordGroup>
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
