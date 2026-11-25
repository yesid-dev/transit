<script lang="ts">
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { Button } from '@yesid/ui/button';
	import { alertDetailsAllowed } from '#lib/features/alerts/alertDetailsAllowed.ts';
	import { chartState } from '#lib/features/record/charts/recordCharts.ts';
	import StateMark from '#lib/features/record/StateMark.svelte';
	import {
		deliveryFinding,
		departureFinding,
		offeredFinding,
		waitingFinding,
	} from './lineRecordText.ts';
	import { intl, type Locale } from '#lib/i18n/index.ts';
	import {
		cautiousRanking,
		choose,
		coverageText,
		departureRankingFloor,
		percent,
		tally,
	} from '#lib/features/record/recordText.ts';
	import { departureHref } from '#lib/features/record/departureIdentity.ts';
	import { waitingMeasures, waitingReadingParts } from '#lib/features/record/waitingText.ts';
	import {
		minuteReading,
		scheduleHours,
		scheduledClock,
		countedUnit,
		tripsInHours,
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
	}: {
		answer: RecordAnswer;
		section: LineSection;
		locale: Locale;
		title: string;
		headsigns: Record<number, string>;
		url: URL;
		line: string;
		city: string;
	} = $props();

	const t = (en: string, fr: string) => choose(locale, en, fr);
	const n = (value: number) => tally(value, locale);
	const p = (value: number) => percent(value, locale);
	const display = transitDisplay();
	const dir = (value: string | number | null | undefined) =>
		display.directionLabel(value, headsigns, locale);
	function destination(direction: number | null | undefined) {
		const name = direction == null ? undefined : headsigns[direction]?.trim();
		return name ? display.readName(name, locale) : undefined;
	}
	const unknown = $derived(t('Unknown', 'Inconnu'));
	const otherLocale = $derived(locale === 'en' ? 'fr' : 'en');
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
		crowding_many_seats: t('Many seats available', 'Beaucoup de places assises libres'),
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
					: [{ label, share, seconds: total == null ? null : share * total }];
			}),
			...(answer.evidence.percentage_levels ?? []).flatMap(
				({ percentage, share, vehicle_seconds }) =>
					share == null || percentage >= 100
						? []
						: [
								{
									label: t(
										`Occupancy reported at ${p(percentage / 100)}`,
										`Achalandage déclaré à ${p(percentage / 100)}`,
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
		<dl class="grid gap-4 sm:grid-cols-2 tabular-nums">
			<div>
				<dt>{t('Distinct alerts', 'Avis distincts')}</dt>
				<dd>{count(answer, 'alerts')}</dd>
			</div>
			<div>
				<dt>{t('Versions of those alerts', 'Versions de ces avis')}</dt>
				<dd>{count(answer, 'alert_versions')}</dd>
			</div>
		</dl>
		{@const messages = answer.evidence.alert_messages ?? []}
		{#if messages.length}
			<ul class="mt-4 grid gap-3">
				{#each messages.slice(0, noticeLimit) as message (JSON.stringify( [message.source, message.id, message.version], ))}
					{@const header = message.header[locale] || message.header[otherLocale]}
					{@const description = message.description[locale] || message.description[otherLocale]}
					<li class="pt-3">
						<h3
							class="font-semibold"
							lang={header && !message.header[locale] ? otherLocale : undefined}
						>
							{header || t(`Alert ${message.id}`, `Avis ${message.id}`)}
						</h3>
						{#if description}
							<p
								class="whitespace-pre-wrap"
								lang={message.description[locale] ? undefined : otherLocale}
							>
								{description}
							</p>
						{/if}
					</li>
				{/each}
			</ul>
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
		{:else if (answer.value.alerts ?? 0) > 0 && alertDetailsAllowed( { from: answer.evidence.start_date, to: answer.evidence.end_date }, )}
			<p class="mt-3">{t('Message text is unavailable.', 'Le texte des avis est indisponible.')}</p>
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
		{@render opening(
			topOccupancy
				? t(
						`The largest reported share was ${p(topOccupancy.share)} of vehicle time with usable occupancy data (${topOccupancy.label}).`,
						`La plus grande part déclarée était de ${p(topOccupancy.share)} du temps des véhicules avec une mesure d’achalandage utilisable (${topOccupancy.label}).`,
					)
				: null,
		)}
		<LineReadingTable
			{title}
			{locale}
			headers={[t('Occupancy level', 'Niveau d’achalandage'), t('Share', 'Part')]}
			rows={occupancy.map(({ label, share, seconds }) => ({
				label,
				values: [
					{
						value: p(share),
						detail:
							seconds == null ? undefined : (minuteReading(seconds / 60, locale) ?? undefined),
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
	{#if answer.rows[0]?.ranking_bound != null}
		<p class="mt-3 text-small text-muted-foreground">{cautiousRanking[locale]}</p>
	{/if}
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
												: intl.number(locale, { maximumFractionDigits: 2 }).format(frequency),
									detail:
										trips == null || hours == null ? undefined : tripsInHours(trips, hours, locale),
								},
					],
				};
			})}
		/>
		<p class="mt-3 text-small text-muted-foreground">
			{t(
				'Scheduled trips per local clock hour, averaged over the timetable days available.',
				'Trajets prévus par heure locale, en moyenne sur les jours dont l’horaire est disponible.',
			)}
		</p>
		<a class="inline-flex min-h-11 items-center text-primary underline" href="#delivery"
			>{t(
				'See scheduled and delivered trips by departure',
				'Voir les trajets prévus et effectués par départ',
			)}</a
		>
	{:else if section === 'delivery'}
		{@render opening(deliveryFinding(answer, locale))}
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
			rows={answer.cells.map((cell) => ({
				label: `${scheduledClock(cell.key.departure, locale)} · ${dir(cell.key.direction)}`,
				values: ['cancelled', 'missing', 'ran', 'scheduled'].map((field) =>
					count(cell, field, true),
				),
			}))}
		/>
	{/if}
{/if}
