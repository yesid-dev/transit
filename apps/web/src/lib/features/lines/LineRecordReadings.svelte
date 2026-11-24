<script lang="ts">
	import { clockFace } from '#lib/utils/time.ts';
	import {
		directionLabel,
		methodEvidence,
		minuteReading,
		scheduledClock,
		tripsInHours,
	} from '#lib/site/presenter.ts';
	import { StatusMark } from '@yesid/ui/brand';
	import { StateNotice } from '@yesid/ui/feedback';
	import { intl, type Locale } from '#lib/i18n/index.ts';
	import {
		choose,
		periodCoverage,
		cautiousRanking,
		coverageText,
		departureRankingFloor,
		emptyRecord,
		measuredShare,
		percent,
		punctualityBands,
		pooledDays,
		punctualityWeighting,
		rateStateText,
		timingBasis,
		shareReading,
		tally,
	} from '#lib/features/record/recordText.ts';
	import type { RecordAnswer, RecordCell } from '#lib/server/engine.ts';
	import type { LineSection } from '#lib/server/lineRecord.ts';
	import RecordTable from '#lib/features/record/RecordTable.svelte';
	import RecordPunctualityDays from '#lib/features/record/RecordPunctualityDays.svelte';
	import RecordSeriesChart from '#lib/features/record/RecordSeriesChart.svelte';
	import { departureHref } from '#lib/features/record/departureIdentity.ts';
	import { lateDepartureReading, lineAnswer } from './lineRecordText.ts';

	let {
		answer,
		section,
		locale,
		title,
		headsigns,
		stopNames,
		url,
		line,
		city,
		direction,
	}: {
		answer: RecordAnswer;
		section: LineSection;
		locale: Locale;
		title: string;
		headsigns: Record<number, string>;
		stopNames: Map<string, string>;
		url: URL;
		line: string;
		city: string;
		direction: string | null;
	} = $props();

	const t = (en: string, fr: string) => choose(locale, en, fr);
	const n = (value: number) => tally(value, locale);
	const p = (value: number) => percent(value, locale);
	const dir = (value: string | number | null | undefined) =>
		directionLabel(value, headsigns, locale);
	const missing = () => emptyRecord(answer.evidence, locale);
	const date = (day: string) =>
		intl.dateTime(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(day));
	const clock = (hour: number) => clockFace(hour, 0);
	const weekday = (day: number) =>
		intl
			.dateTime(locale, { weekday: 'short', timeZone: 'UTC' })
			.format(new Date(Date.UTC(2026, 10, day + 1)));
	const dayType = (value: string) =>
		({
			weekday: t('Weekday', 'Jour de semaine'),
			saturday: t('Saturday', 'Samedi'),
			sunday: t('Sunday', 'Dimanche'),
		})[value] ?? t('Unknown', 'Inconnu');
	const count = (cell: RecordCell, key: string, isTripCount = false) => {
		const value = cell.evidence.counts[key];
		// The delivery sample floor applies to rates, while known nonzero counts are still evidence.
		if (
			cell.state !== 'measured' &&
			!(isTripCount && cell.state === 'too_few_to_judge' && value != null && value > 0)
		)
			return cell.state_text[locale];
		return value == null ? t('Unknown', 'Inconnu') : n(value);
	};
	const median = (cell: RecordCell) => {
		if (cell.state !== 'measured') return rateStateText(cell, locale);
		return (
			minuteReading((cell.value.median_delay ?? NaN) / 60, locale, true) ?? t('Unknown', 'Inconnu')
		);
	};
	const levelLabels = $derived({
		crowding_empty: t('Empty', 'Vide'),
		crowding_many_seats: t('Many seats available', 'Beaucoup de places assises libres'),
		crowding_few_seats: t('Few seats available', 'Peu de places assises libres'),
		crowding_standing: t('Standing room only', 'Places debout seulement'),
		crowding_crushed: t('Limited standing room', 'Peu de places debout'),
		crowding_full: t('Full', 'Plein'),
	});
</script>

{#if 'value' in answer}
	{#if section === 'punctuality'}
		{@const basis = timingBasis(answer.evidence.counts, locale)}
		<p>{lineAnswer(answer, answer.evidence, locale)}</p>
		{#if basis}<p>{basis}</p>{/if}
		<p>{punctualityWeighting[locale]}</p>
		{#if answer.evidence.start_date !== answer.evidence.end_date}<p>{pooledDays[locale]}</p>{/if}
		<dl class="flex flex-wrap gap-4">
			{#each punctualityBands(answer, locale) as band (band.id)}
				<div>
					<dt><StatusMark status={band.id} label={band.label} /></dt>
					<dd>{band.reading}</dd>
				</div>
			{/each}
		</dl>
	{:else if section === 'alerts'}
		<dl class="flex flex-wrap gap-4">
			<div>
				<dt>{t('Distinct alerts', 'Avis distincts')}</dt>
				<dd>{count(answer, 'alerts')}</dd>
			</div>
			<div>
				<dt>{t('Versions of those alerts', 'Versions de ces avis')}</dt>
				<dd>{count(answer, 'alert_versions')}</dd>
			</div>
		</dl>
	{:else if section === 'crowding'}
		{@const coverage = coverageText(answer.evidence, locale)}
		<p>
			{t(
				'Share of vehicle time with a usable occupancy value, by level.',
				'Part du temps des véhicules avec une mesure d’achalandage utilisable, par niveau.',
			)}
			{#if answer.evidence.counts.occupancy_vehicle_seconds != null}
				{t('Vehicle time with a usable value', 'Temps des véhicules avec une valeur utilisable')}
				({minuteReading(answer.evidence.counts.occupancy_vehicle_seconds / 60, locale)}).
			{/if}
		</p>
		{#if coverage}<p>{coverage}.</p>{/if}
		<RecordTable
			{title}
			headers={[t('Occupancy level', 'Niveau d’achalandage'), t('Share', 'Part')]}
			rows={[
				...Object.entries(levelLabels).flatMap(([key, label]) => {
					const value = answer.value[key];
					return value == null ? [] : [[label, p(value)]];
				}),
				...(answer.evidence.percentage_levels ?? []).flatMap(({ percentage, share }) =>
					share == null || percentage >= 100
						? []
						: [
								[
									t(
										`Occupancy reported at ${p(percentage / 100)}`,
										`Achalandage déclaré à ${p(percentage / 100)}`,
									),
									p(share),
								],
							],
				),
			]}
		/>
	{:else if section === 'frequency'}
		<RecordTable
			{title}
			headers={[
				t('Part of the day', 'Moment de la journée'),
				direction == null
					? t(
							'Trips per hour (both directions combined)',
							'Trajets par heure (les deux directions combinées)',
						)
					: t('Trips per hour', 'Trajets par heure'),
				t('Trips / hours', 'Trajets / heures'),
			]}
			rows={(answer.evidence.periods ?? []).map((period) => [
				`${dayType(period.day_type)} · ${period.period_text[locale]} · ${clock(period.start_hour)}–${clock(period.end_hour)}`,
				period.scheduled_trips === 0
					? t('No service scheduled', 'Aucun service prévu')
					: intl.number(locale, { maximumFractionDigits: 2 }).format(period.scheduled_frequency),
				tripsInHours(period.scheduled_trips, period.scheduled_clock_hours, locale),
			])}
		/>
	{/if}
{:else if 'rows' in answer && answer.kind === 'departure'}
	{@const info = answer.info[0]}
	{@const floors = info?.ranking_floors?.departure}
	<p>
		{answer.rows[0]?.ranking_bound != null
			? t(cautiousRanking.en, cautiousRanking.fr)
			: t(
					'Ranked by the late share of observed stop events on each scheduled departure.',
					'Classement selon la part des passages observés en retard pour chaque départ prévu.',
				)}
	</p>
	<RecordTable
		{title}
		headers={[
			t('Departure', 'Départ'),
			t('Direction', 'Direction'),
			t('Late share', 'Part en retard'),
		]}
		rows={answer.rows.map((row) => [
			scheduledClock(row.departure, locale),
			dir(row.direction),
			lateDepartureReading(row, locale),
		])}
	>
		{#snippet rowLabel(label, index)}
			{@const row = answer.rows[index]!}
			{@const href = departureHref(url, locale, city, line, row.direction, row.departure)}
			{#if href}<a class="inline-flex min-h-11 items-center" {href}>{label}</a>{:else}{label}{/if}
		{/snippet}
	</RecordTable>
	{#if info}
		<p>
			{floors
				? departureRankingFloor(floors, locale)
				: t(
						`At least ${n(info.minimum_sample)} observed stop events per departure.`,
						`Au moins ${n(info.minimum_sample)} passages observés par départ.`,
					)}
		</p>
	{/if}
{:else if 'cells' in answer}
	{@const cells = answer.cells}
	{#if section === 'offered'}
		<RecordSeriesChart
			{title}
			seriesLabel={t('Trips per hour', 'Trajets par heure')}
			points={cells.map((cell) => ({
				x: Number(cell.key.hour),
				y: cell.state === 'measured' ? (cell.value.scheduled_frequency ?? null) : null,
			}))}
			ticks={[0, 6, 12, 18, 24].map((value) => ({ value, label: clock(value) }))}
			yMax={Math.max(
				2,
				...cells.map((cell) =>
					cell.state === 'measured' ? (cell.value.scheduled_frequency ?? 0) : 0,
				),
			)}
			format={(value) => intl.number(locale, { maximumFractionDigits: 1 }).format(value)}
		/>
		<p>
			{t(
				'Scheduled trips per local clock hour, averaged over the timetable days available.',
				'Trajets prévus par heure locale, en moyenne sur les jours dont l’horaire est disponible.',
			)}
		</p>
		<p>{periodCoverage(answer.evidence, locale)}. {methodEvidence(answer.evidence, locale)}</p>
		<RecordTable
			{title}
			headers={[
				t('Local time', 'Heure locale'),
				direction == null
					? t(
							'Trips per hour (both directions combined)',
							'Trajets par heure (les deux directions combinées)',
						)
					: t('Trips per hour', 'Trajets par heure'),
				t('Scheduled trips and hours', 'Trajets prévus et heures'),
			]}
			rows={cells.map((cell) => {
				const hour = Number(cell.key.hour);
				const label = `${clock(hour)}–${clock(hour + 1)}`;
				const { scheduled_frequency: frequency } = cell.value;
				const { scheduled_trips: trips, scheduled_clock_hours: hours } = cell.evidence.counts;
				if (cell.state !== 'measured' || frequency == null || trips == null || hours == null)
					return [label, cell.state_text[locale], t('Unavailable', 'Indisponible')];
				return [
					label,
					trips === 0
						? t('No service scheduled', 'Aucun service prévu')
						: intl.number(locale, { maximumFractionDigits: 2 }).format(frequency),
					tripsInHours(trips, hours, locale),
				];
			})}
		/>
	{:else if section === 'daily'}
		<RecordPunctualityDays {title} series={answer} {locale} />
		<RecordTable
			{title}
			headers={[t('Service date', 'Date de service'), t('On-time share', 'Part à l’heure')]}
			rows={cells.map((cell) => [
				date(String(cell.key.day)),
				shareReading(cell, 'on_time', locale),
			])}
		/>
	{:else if section === 'hourly'}
		{@const byHour = new Map(cells.map((cell) => [`${cell.key.weekday}/${cell.key.hour}`, cell]))}
		{@const weekdays = Array.from({ length: 7 }, (_, index) => index + 1)}
		<p>
			{t(
				'Late share by scheduled local hour (late passages / observed passages).',
				'Part en retard selon l’heure locale prévue (passages en retard / passages observés).',
			)}
		</p>
		<RecordTable
			{title}
			wide
			headers={[t('Hour', 'Heure'), ...weekdays.map(weekday)]}
			heatLevels={Array.from({ length: 24 }, (_, hour) =>
				weekdays.map((day) => {
					const share = measuredShare(byHour.get(`${day}/${hour}`), 'late');
					return share === null ? null : Math.min(4, Math.floor(share * 5));
				}),
			)}
			rows={Array.from({ length: 24 }, (_, hour) => [
				clock(hour),
				...weekdays.map((day) => {
					const cell = byHour.get(`${day}/${hour}`);
					return cell ? shareReading(cell, 'late', locale) : missing();
				}),
			])}
		/>
	{:else if section === 'directions'}
		<RecordTable
			{title}
			headers={[
				t('Direction', 'Direction'),
				...punctualityBands(cells[0]!, locale).map(({ label }) => label),
				t('Timing sources', 'Sources des heures'),
			]}
			rows={cells.map((cell) => [
				dir(cell.key.direction),
				...punctualityBands(cell, locale).map(({ reading }) => reading),
				cell.state === 'measured'
					? timingBasis(cell.evidence.counts, locale) || t('Unknown', 'Inconnu')
					: rateStateText(cell, locale),
			])}
		/>
	{:else if section === 'stops'}
		<p>
			{t(
				'Compare median delay and late share in scheduled stop order. Branches can share a position.',
				'Comparez le retard médian et la part en retard dans l’ordre prévu des arrêts. Des branches peuvent partager un rang.',
			)}
		</p>
		<RecordTable
			{title}
			headers={[
				t('Stop', 'Arrêt'),
				t('Median delay', 'Retard médian'),
				t('Late share', 'Part en retard'),
			]}
			rows={cells.map((cell) => {
				const stop = String(cell.key.stop);
				return [
					`${dir(cell.key.direction)} · ${cell.key.stop_sequence}. ${stopNames.get(stop) ?? stop}`,
					median(cell),
					shareReading(cell, 'late', locale),
				];
			})}
		/>
	{:else if section === 'delivery'}
		<p>
			{t(
				'Cancelled trips were reported as cancelled. Missing trips had no vehicle evidence or cancellation.',
				'Les trajets annulés ont été signalés comme tels. Les trajets manquants sont sans trace de véhicule ni annulation.',
			)}
		</p>
		<RecordTable
			{title}
			headers={[
				t('Departure', 'Départ'),
				t('Cancelled', 'Annulés'),
				t('Missing', 'Manquants'),
				t('Ran', 'Effectués'),
				t('Scheduled', 'Prévus'),
				t('Coverage', 'Couverture'),
			]}
			rows={cells.map((cell) => [
				`${scheduledClock(cell.key.departure, locale)} · ${dir(cell.key.direction)}`,
				count(cell, 'cancelled', true),
				count(cell, 'missing', true),
				count(cell, 'ran', true),
				count(cell, 'scheduled', true),
				coverageText(cell.evidence, locale) || t('Unknown', 'Inconnue'),
			])}
		/>
	{:else if section === 'boundaries'}
		<p>
			{t(
				'First and last scheduled departures in GTFS service time. Hours past 24:00 belong to the same service day.',
				'Premiers et derniers départs prévus en heure de service GTFS. Les heures après 24:00 appartiennent au même jour de service.',
			)}
		</p>
		{#each cells as cell (cell.key.day_type)}
			{@const rows = (cell.evidence.boundary_departures ?? []).map((row) => [
				date(row.service_date),
				row.measure === 'first_trip' ? t('First', 'Premier') : t('Last', 'Dernier'),
				scheduledClock(row.scheduled_departure, locale),
				n(row.scheduled),
			])}
			<h3>{dayType(String(cell.key.day_type))}</h3>
			{#if rows.length}
				<RecordTable
					title={dayType(String(cell.key.day_type))}
					headers={[
						t('Date', 'Date'),
						t('Trip', 'Trajet'),
						t('Departure', 'Départ'),
						t('Scheduled', 'Prévus'),
					]}
					{rows}
				/>
			{:else}
				<StateNotice presentation="frameless" title={cell.state_text[locale]} />
			{/if}
		{/each}
	{/if}
{/if}
