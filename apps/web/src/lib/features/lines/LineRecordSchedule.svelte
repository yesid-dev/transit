<script lang="ts">
	import { SegmentedChoice, type StampProps } from '@yesid/ui/brand';
	import type { Locale } from '#lib/i18n/index.ts';
	import RecordCard from '#lib/features/record/RecordCard.svelte';
	import { choose } from '#lib/features/record/recordText.ts';
	import {
		scheduleHours,
		scheduledClock,
		plannedInterval,
		dailyScheduledTrips,
	} from '#lib/site/presenter.ts';
	import type { RecordMeasure, RecordSeries } from '#lib/server/engine.ts';
	import LineReadingTable from './LineReadingTable.svelte';
	import LineRecordEvidence from './LineRecordEvidence.svelte';

	let {
		frequency,
		boundaries,
		locale,
		stamp,
		day,
		unavailable,
		busy,
		combined,
	}: {
		frequency?: RecordMeasure;
		boundaries?: RecordSeries;
		locale: Locale;
		stamp: StampProps;
		day?: string | null;
		unavailable?: boolean;
		busy?: boolean;
		combined: boolean;
	} = $props();

	const t = (en: string, fr: string) => choose(locale, en, fr);
	const title = $derived(t('Schedule', 'Horaire'));
	const dayTypes = $derived([
		{ key: 'weekday', label: t('Weekday', 'Jour de semaine') },
		{ key: 'saturday', label: t('Saturday', 'Samedi') },
		{ key: 'sunday', label: t('Sunday', 'Dimanche') },
	]);
	let selection = $state<string>();
	const selected = $derived(
		selection ?? (dayTypes.some(({ key }) => key === day) ? day! : 'weekday'),
	);
	const periods = $derived(
		frequency?.state === 'measured'
			? (frequency.evidence.periods?.filter((period) => period.day_type === selected) ?? [])
			: [],
	);
	const boundary = $derived(boundaries?.cells.find(({ key }) => key.day_type === selected));
	const edges = $derived(boundary?.evidence.boundary_departures ?? []);
	const trips = $derived(
		periods.length && periods[0].days
			? periods.reduce((total, period) => total + period.scheduled_trips, 0) / periods[0].days
			: null,
	);

	function edge(kind: 'first_trip' | 'last_trip') {
		const times = edges
			.filter(({ measure }) => measure === kind)
			.map(({ scheduled_departure }) => scheduled_departure)
			.sort();
		if (!times.length) return null;
		const distinct = [...new Set(times.map((time) => scheduledClock(time, locale)))];
		return distinct.length === 1
			? distinct[0]
			: t(`${distinct[0]} to ${distinct.at(-1)}`, `${distinct[0]} à ${distinct.at(-1)}`);
	}
</script>

<div class="min-w-0">
	<RecordCard {title} {stamp}>
		<div class="grid min-w-0 grid-cols-1 gap-3">
			<SegmentedChoice
				options={dayTypes}
				value={selected}
				label={t('Day type', 'Type de jour')}
				onSelect={(key) => (selection = key)}
			/>
			{#if unavailable}<p>
					{t('The record is temporarily unavailable.', 'Le bilan est temporairement indisponible.')}
				</p>{/if}
			<dl id="boundaries" class="grid grid-cols-1 gap-3 tabular-nums sm:grid-cols-3">
				{#each [{ label: t('First trip', 'Premier trajet'), value: edge('first_trip') }, { label: t('Last trip', 'Dernier trajet'), value: edge('last_trip') }, { label: selected === 'weekday' ? t('Average trips per weekday', 'Moyenne de trajets par jour de semaine') : t('Average trips per day', 'Moyenne de trajets par jour'), value: trips === null ? null : dailyScheduledTrips(trips, locale) }] as item (item.label)}
					{#if item.value != null}
						<div>
							<dt>{item.label}</dt>
							<dd class="text-heading font-semibold">{item.value}</dd>
						</div>
					{/if}
				{/each}
			</dl>
			{#if periods.length}
				{#if combined}
					<p class="text-small text-muted-foreground">
						{t(
							'Planned frequency combines both directions.',
							'La fréquence prévue combine les deux directions.',
						)}
					</p>
				{/if}
				<div id="frequency" class="min-w-0">
					<LineReadingTable
						title={t('Planned frequency', 'Fréquence prévue')}
						{locale}
						numeric={false}
						headers={[
							t('Part of the day', 'Moment de la journée'),
							t('Hours', 'Heures'),
							t('Planned frequency', 'Fréquence prévue'),
						]}
						rows={periods.map((period) => ({
							label: period.period_text[locale],
							values: [
								scheduleHours(period.start_hour, period.end_hour, locale),
								period.scheduled_trips
									? plannedInterval(period.scheduled_frequency, locale)
									: t('No service scheduled', 'Aucun service prévu'),
							],
						}))}
					/>
				</div>
			{:else if !unavailable && !busy}
				<p>
					{frequency && frequency.state !== 'measured'
						? frequency.state_text[locale]
						: t('No timetable for this day type', 'Aucun horaire pour ce type de jour')}
				</p>
			{/if}
		</div>
		{#snippet footer()}
			{#if frequency}<LineRecordEvidence evidence={frequency.evidence} {locale} />{/if}
		{/snippet}
	</RecordCard>
</div>
