<script lang="ts">
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { page } from '$app/state';
	import { Button } from '@yesid/ui/button';
	import { alertDetailsAllowed, alertDetailsLimit } from '#lib/features/alerts/alertRecord.ts';
	import { groupAlertCards, recordAlertCards } from '#lib/features/alerts/alertCards.ts';
	import NoticeRows from '#lib/features/alerts/NoticeRows.svelte';
	import type { PublicCity } from '#lib/v1/schemas/providers.ts';
	import { chartState } from '#lib/features/record/charts/recordCharts.ts';
	import StateMark from '#lib/features/record/StateMark.svelte';
	import {
		crowdingFinding,
		deliveryFinding,
		departureFinding,
		offeredFinding,
		waitingFinding,
	} from './lineRecordText.ts';
	import type { Locale } from '#lib/i18n/index.ts';
	import {
		choose,
		coverageText,
		departureRankingFloor,
		tally,
	} from '#lib/features/record/recordText.ts';
	import { departureHref } from '#lib/features/record/departureIdentity.ts';
	import { waitingMeasures, waitingReadingParts } from '#lib/features/record/waitingText.ts';
	import {
		recordPercent,
		vehicleHours,
		scheduleHours,
		scheduledClock,
		countedUnit,
		deliveryFacts,
		recordRatio,
		tooFewDepartures,
		unconfirmedTrips,
		tripsAnHour,
		tripsOverDays,
		agencyName,
		noPublishedNotices,
	} from '#lib/site/presenter.ts';
	import type { RecordAnswer, RecordCell } from '#lib/server/engine.ts';
	import type { LineSection } from '#lib/server/lineRecord.ts';
	import LineReadingTable from './LineReadingTable.svelte';

	let {
		answer,
		section,
		locale,
		title,
		headsigns,
		url,
		line,
		city,
		stopNames,
		operator,
	}: {
		answer: RecordAnswer;
		section: LineSection;
		locale: Locale;
		title: string;
		headsigns: Record<number, string>;
		url: URL;
		line: string;
		city: string;
		stopNames: Record<string, string>;
		operator: string;
	} = $props();

	const t = (en: string, fr: string) => choose(locale, en, fr);
	const n = (value: number) => tally(value, locale);
	const p = (value: number) => recordPercent(value, locale);
	const display = transitDisplay();
	const dir = (value: string | number | null | undefined) =>
		display.directionLabel(value, headsigns, locale);
	function destination(direction: number | null | undefined) {
		const name = direction == null ? undefined : headsigns[direction]?.trim();
		return name ? display.toward(name, locale, false) : undefined;
	}
	const unknown = $derived(t('Unknown', 'Inconnu'));
	const provider = $derived(page.data.provider as PublicCity | undefined);
	const stopName = (id: string) => (stopNames[id] ? display.readName(stopNames[id], locale) : id);
	let noticeLimit = $state(3);
	const count = (cell: RecordCell, key: string, trip = false) => {
		const value = cell.evidence.counts[key];
		if (
			cell.state !== 'measured' &&
			!(trip && cell.state === 'too_few_to_judge' && value != null && value > 0)
		)
			return cell.state_text[locale];
		return value == null ? unknown : n(value);
	};
	const levelLabels = $derived({
		crowding_empty: t('Empty', 'Vide'),
		crowding_many_seats: t('Many seats available', 'Plusieurs places assises libres'),
		crowding_few_seats: t('Few seats available', 'Peu de places assises libres'),
		crowding_standing: t('Standing room only', 'Places debout seulement'),
		crowding_crushed: t('Limited standing room', 'Peu de places debout'),
		crowding_full: t('Full', 'Plein'),
	});
	const occupancy = $derived.by(() => {
		if (!('value' in answer) || section !== 'crowding') return [];
		const total = answer.evidence.counts.occupancy_vehicle_seconds;
		return [
			...Object.entries(levelLabels).flatMap(([key, label]) => {
				const share = answer.value[key];
				return share == null
					? []
					: [{ key, label, share, seconds: total == null ? null : share * total }];
			}),
			...(answer.evidence.percentage_levels ?? []).flatMap(
				({ percentage, share, vehicle_seconds }) =>
					share == null || percentage >= 100
						? []
						: [
								{
									key: 'percentage',
									percentage,
									label: t(
										`Occupancy reported at ${p(percentage / 100)}`,
										`Occupation déclarée à ${p(percentage / 100)}`,
									),
									share,
									seconds: vehicle_seconds,
								},
							],
			),
		];
	});
	const topOccupancy = $derived(
		occupancy.reduce<(typeof occupancy)[number] | undefined>(
			(top, level) => (!top || level.share > top.share ? level : top),
			undefined,
		),
	);
</script>

{#snippet opening(finding: string | null)}
	<p class="mb-3">
		{#if finding}{finding}{:else}
			<StateMark state={chartState('state' in answer ? answer.state : undefined)} {locale} />
		{/if}
	</p>
{/snippet}

{#if 'value' in answer}
	{#if section === 'alerts'}
		{@const messages = groupAlertCards(recordAlertCards(answer.evidence.alert_messages))}
		{#if answer.value.alerts != null && answer.value.alerts > 0}
			<p class="mb-3">{countedUnit(answer.value.alerts, 'distinct-alert', locale)}</p>
		{/if}
		{#if answer.value.alerts === 0}
			<p>
				{noPublishedNotices(
					agencyName(operator, provider),
					'line',
					locale,
					!answer.evidence.days_not_measured.length && !answer.evidence.days_not_tracked?.length,
				)}
			</p>
		{:else if messages.length}
			<NoticeRows
				cards={messages.slice(0, noticeLimit)}
				{locale}
				timeZone={provider?.timezone}
				{stopName}
			/>
			{#if messages.length > noticeLimit}
				<Button
					class="mt-3 min-h-11"
					variant="outline"
					size="sm"
					onclick={() => (noticeLimit += 3)}
				>
					{t('Show more notices', 'Afficher d’autres avis')}
				</Button>
			{/if}
		{:else if !alertDetailsAllowed( { from: answer.evidence.start_date, to: answer.evidence.end_date } )}
			<p>{alertDetailsLimit[locale]}</p>
		{:else}
			<p>{t('Message text is unavailable.', 'Le texte des avis est indisponible.')}</p>
		{/if}
	{:else if section === 'waiting'}
		{@render opening(waitingFinding(answer, locale))}
		<dl class="grid gap-4 sm:grid-cols-3 tabular-nums">
			{#each waitingMeasures as [id, en, fr] (id)}
				{@const reading = waitingReadingParts(answer, id, locale)}
				<div>
					<dt>{t(en, fr)}</dt>
					<dd class="font-semibold">{reading.value}</dd>
					{#if reading.detail}<dd class="text-small text-muted-foreground">
							{reading.detail}
						</dd>{/if}
				</div>
			{/each}
		</dl>
		{#if coverageText(answer.evidence, locale)}<p class="mt-3 text-small text-muted-foreground">
				{coverageText(answer.evidence, locale)}.
			</p>{/if}
	{:else if section === 'crowding'}
		{@render opening(topOccupancy ? crowdingFinding(topOccupancy, locale) : null)}
		<LineReadingTable
			{title}
			{locale}
			headers={[t('Room on board', 'Places à bord'), t('Share', 'Part')]}
			rows={occupancy.map(({ label, share, seconds }) => ({
				label,
				values: [
					{
						value: p(share),
						detail: seconds == null ? undefined : vehicleHours(seconds, locale),
					},
				],
			}))}
		/>
	{/if}
{:else if 'rows' in answer && answer.kind === 'departure'}
	{@const floors = answer.info[0]?.ranking_floors?.departure}
	{@render opening(departureFinding(answer, destination(answer.rows[0]?.direction), locale))}
	<LineReadingTable
		{title}
		{locale}
		headers={[t('Departure', 'Départ'), t('Late share', 'Part en retard')]}
		rows={answer.rows.map((row) => ({
			label: `${scheduledClock(row.departure, locale)} · ${dir(row.direction)}`,
			href: departureHref(url, locale, city, line, row.direction, row.departure),
			values: [{ value: p(row.value), detail: countedUnit(row.sample, 'event', locale) }],
		}))}
	/>
	{#if floors}<p class="mt-3 text-small text-muted-foreground">
			{departureRankingFloor(floors, locale)}
		</p>{/if}
{:else if 'cells' in answer}
	{#if section === 'offered'}
		{@render opening(offeredFinding(answer, locale))}
		<LineReadingTable
			{title}
			{locale}
			headers={[t('Local time', 'Heure locale'), t('Trips per hour', 'Trajets par heure')]}
			rows={answer.cells.map((cell) => {
				const hour = Number(cell.key.hour);
				const { scheduled_frequency: frequency } = cell.value;
				const { scheduled_trips: trips, scheduled_clock_hours: hours } = cell.evidence.counts;
				return {
					label: scheduleHours(hour, hour + 1, locale),
					values: [
						cell.state !== 'measured'
							? cell.state_text[locale]
							: {
									value:
										frequency == null
											? unknown
											: trips === 0
												? t('No service scheduled', 'Aucun service prévu')
												: tripsAnHour(frequency, locale),
									// Each timetable day gives this clock hour once.
									detail:
										trips == null || hours == null
											? undefined
											: tripsOverDays(trips, hours, locale),
								},
					],
				};
			})}
		/>
		<p class="mt-3 text-small text-muted-foreground">
			{t(
				'The trips the timetable plans in each hour, on average over the days it covers.',
				'Les trajets que l’horaire prévoit dans chaque heure, en moyenne sur les jours qu’il couvre.',
			)}
		</p>
		<a class="inline-flex min-h-11 items-center text-primary underline" href="#delivery"
			>{t(
				'See scheduled and delivered trips by departure',
				'Voir les trajets prévus et effectués par départ',
			)}</a
		>
	{:else if section === 'delivery'}
		{@const finding = deliveryFinding(answer, locale)}
		{@const thin =
			answer.cells.some((cell) => cell.state === 'too_few_to_judge') &&
			answer.cells.every(
				(cell) => cell.state === 'too_few_to_judge' || cell.state === 'not_measured',
			)}
		<!-- No departure has enough trips: the state and its reason, once, in one line. -->
		{#if finding || !thin}{@render opening(finding)}{/if}
		{#if answer.cells.some((cell) => cell.state === 'measured')}
			<LineReadingTable
				{title}
				{locale}
				headers={[
					t('Departure', 'Départ'),
					t('Cancelled', 'Annulés'),
					t('Missing', 'Manquants'),
					t('Ran', 'Effectués'),
					t('Scheduled', 'Prévus'),
				]}
				rows={answer.cells.map((cell) => {
					const { ran, scheduled, cancelled, missing } = cell.evidence.counts;
					return {
						label: `${scheduledClock(cell.key.departure, locale)} · ${dir(cell.key.direction)}`,
						values: ['cancelled', 'missing', 'ran', 'scheduled'].map((field) =>
							count(cell, field, true),
						),
						phone:
							cell.state === 'measured' && ran != null && scheduled != null
								? {
										value: recordRatio(ran, n(scheduled), locale),
										line: deliveryFacts(cancelled ?? null, missing ?? null, locale),
									}
								: { value: cell.state_text[locale], line: null },
					};
				})}
			/>
		{:else if thin}
			{@const most = Math.max(...answer.cells.map((cell) => cell.evidence.counts.scheduled ?? 0))}
			{@const minimum = answer.info?.[0]?.minimum_sample}
			{@const unconfirmed = answer.cells.reduce(
				(total, cell) =>
					total + (cell.state === 'not_measured' ? (cell.evidence.counts.unconfirmed ?? 0) : 0),
				0,
			)}
			<p>
				<StateMark state="too_few_to_judge" {locale} />
				{tooFewDepartures(most, minimum ?? null, locale)}
				{#if unconfirmed}{unconfirmedTrips(unconfirmed, locale)}{/if}
			</p>
		{/if}
	{/if}
{/if}
