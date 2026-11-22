<script lang="ts">
	import { intl, type Locale } from '#lib/i18n/index.ts';
	import {
		choose,
		emptyRecord,
		percent,
		punctualityBands,
		shareReading,
		tally,
	} from '#lib/features/record/recordText.ts';
	import type { RecordAnswer, RecordCell } from '#lib/server/engine.ts';
	import type { LineSection } from '#lib/server/lineRecord.ts';
	import RecordTable from '#lib/features/record/RecordTable.svelte';
	import { departureHref } from '#lib/features/record/departureIdentity.ts';
	import { directionLabel, lateDepartureReading, lineAnswer } from './lineRecordText.ts';

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
	} = $props();

	const t = (en: string, fr: string) => choose(locale, en, fr);
	const n = (value: number) => tally(value, locale);
	const p = (value: number) => percent(value, locale);
	const dir = (value: string | number | null | undefined) =>
		directionLabel(value, headsigns, locale);
	const missing = () => emptyRecord(answer.evidence, locale);
	const date = (day: string) =>
		intl.dateTime(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(day));
	const clock = (hour: number) => `${String(hour).padStart(2, '0')}:00`;
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
		if (cell.state !== 'measured') return cell.state_text[locale];
		const delay = cell.value.median_delay;
		return delay == null
			? t('Unknown', 'Inconnu')
			: `${intl.number(locale, { maximumFractionDigits: 1, signDisplay: 'exceptZero' }).format(delay / 60)} min`;
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
		<p>{lineAnswer(answer, answer.evidence, locale)}</p>
		<dl class="flex flex-wrap gap-4">
			{#each punctualityBands(answer, locale) as band (band.id)}
				<div>
					<dt>{band.label}</dt>
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
		<p>
			{t(
				'Share of vehicle time with a usable occupancy value, by level.',
				'Part du temps des véhicules avec une mesure d’achalandage utilisable, par niveau.',
			)}
			{#if answer.evidence.counts.occupancy_vehicle_seconds != null}
				{t('Vehicle-seconds with a usable value', 'Secondes-véhicules avec une valeur utilisable')}
				({n(answer.evidence.counts.occupancy_vehicle_seconds)}).
			{/if}
		</p>
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
				t('Trips per hour', 'Trajets par heure'),
				t('Trips / hours', 'Trajets / heures'),
			]}
			rows={(answer.evidence.periods ?? []).map((period) => [
				`${dayType(period.day_type)} · ${period.period_text[locale]} · ${clock(period.start_hour)}–${clock(period.end_hour)}`,
				period.scheduled_trips === 0
					? t('No service scheduled', 'Aucun service prévu')
					: intl.number(locale, { maximumFractionDigits: 2 }).format(period.scheduled_frequency),
				`${n(period.scheduled_trips)}/${n(period.scheduled_clock_hours)}`,
			])}
		/>
	{/if}
{:else if 'rows' in answer && answer.kind === 'departure'}
	<p>
		{t(
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
			row.departure,
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
	{#if answer.info[0]}
		<p>
			{t(
				`At least ${n(answer.info[0].minimum_sample)} observed stop events per departure.`,
				`Au moins ${n(answer.info[0].minimum_sample)} passages observés par départ.`,
			)}
		</p>
	{/if}
{:else if 'cells' in answer}
	{@const cells = answer.cells}
	{#if section === 'daily'}
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
			]}
			rows={cells.map((cell) => [
				dir(cell.key.direction),
				...punctualityBands(cell, locale).map(({ reading }) => reading),
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
				t('Scheduled', 'Prévus'),
			]}
			rows={cells.map((cell) => [
				`${cell.key.departure} · ${dir(cell.key.direction)}`,
				count(cell, 'cancelled', true),
				count(cell, 'missing', true),
				count(cell, 'scheduled', true),
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
				row.scheduled_departure,
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
				<p>{cell.state_text[locale]}</p>
			{/if}
		{/each}
	{/if}
{/if}
