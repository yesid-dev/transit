<script lang="ts">
	import type { Awaitable } from '#lib/site/ready.ts';
	import { SegmentedChoice, type StampProps } from '@yesid/ui/brand';
	import type { Locale } from '#lib/i18n/index.ts';
	import RecordCard from '#lib/features/record/RecordCard.svelte';
	import { choose } from '#lib/features/record/recordText.ts';
	import {
		scheduleHours,
		scheduledClock,
		plannedInterval,
		dailyScheduledTrips,
		sparseService,
		towardReading,
	} from '#lib/site/presenter.ts';
	import type { RecordMeasure, RecordSeries, getRecordAnswer } from '#lib/server/engine.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import RecordSkeleton from '../record/RecordSkeleton.svelte';
	import RecordPending from '../record/RecordPending.svelte';
	import RecordUnavailable from '../record/RecordUnavailable.svelte';
	import LineReadingTable from './LineReadingTable.svelte';
	import LineRecordEvidence from './LineRecordEvidence.svelte';

	let {
		frequency,
		boundaries,
		locale,
		stamp,
		day,
		unavailable,
		pending,
		retry,
		direction,
		directionalFrequency,
		headsigns,
	}: {
		frequency?: RecordMeasure;
		boundaries?: RecordSeries;
		locale: Locale;
		stamp: StampProps;
		day?: string | null;
		unavailable?: boolean;
		pending?: { busy?: boolean; answer?: Awaitable<Awaited<ReturnType<typeof getRecordAnswer>>> };
		retry?: () => void;
		direction: string | null;
		directionalFrequency: Awaitable<Awaited<ReturnType<typeof getRecordAnswer>>> | null;
		headsigns: Record<number, string>;
	} = $props();

	const t = (en: string, fr: string) => choose(locale, en, fr);
	const display = transitDisplay();
	const tableShape = { shape: 'table', rows: 5 } as const;
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
	type Period = NonNullable<RecordMeasure['evidence']['periods']>[number];

	function reading(period: Period, directions?: RecordSeries) {
		if (!period.scheduled_trips) return t('No service scheduled', 'Aucun service prévu');
		let sign = direction == null ? undefined : headsigns[Number(direction)];
		let rate = direction == null ? undefined : period.scheduled_frequency;
		for (const cell of directions?.cells ?? []) {
			const id = cell.key.direction;
			if (typeof id !== 'number' || cell.state !== 'measured') continue;
			const match = cell.evidence.periods?.find(
				(candidate) =>
					candidate.day_type === period.day_type && candidate.start_hour === period.start_hour,
			);
			if (!match?.scheduled_frequency || (rate != null && match.scheduled_frequency <= rate))
				continue;
			rate = match.scheduled_frequency;
			sign = headsigns[id];
		}
		if (rate == null) return t('Unknown', 'Inconnue');
		// At most one trip an hour: say the trips of the part, not an interval over empty hours.
		if (rate <= 1 && period.days)
			return sparseService(
				period.scheduled_trips / period.days,
				{ start: period.start_hour, end: period.end_hour },
				edges
					.filter(({ measure }) => measure === 'last_trip')
					.map((edge) => edge.scheduled_departure),
				locale,
			);
		const interval = plannedInterval(rate, locale);
		return sign
			? `${interval} ${towardReading(sign, locale, display.directory.nameSeparators, false)}`
			: interval;
	}

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

{#snippet timetable(directions?: RecordSeries)}
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
					reading(period, directions),
				],
			}))}
		/>
	</div>
{/snippet}

<div class="grid min-w-0 min-[1280px]:min-h-[30.75rem]">
	<RecordCard interactive {title} {stamp}>
		<div class="min-h-[25rem]">
			<div class="grid min-w-0 grid-cols-1 gap-3">
				<SegmentedChoice
					options={dayTypes}
					value={selected}
					label={t('Day type', 'Type de jour')}
					onSelect={(key) => (selection = key)}
				/>
				{#if pending}
					<div class="sm:hidden"><RecordSkeleton shape="facts" /></div>
					<div class="hidden grid-cols-3 gap-3 sm:grid">
						{#each dayTypes as { key } (key)}
							<RecordSkeleton shape={{ shape: 'facts', count: 1 }} />
						{/each}
					</div>
					<RecordPending {locale} {...pending} shape={tableShape} />
				{:else}
					{#if unavailable}
						<RecordUnavailable
							{locale}
							retry={retry &&
								(() => {
									retry?.();
									if (directionalFrequency)
										void Promise.resolve(directionalFrequency).then((result) => {
											if (result.kind === 'unreachable') result.retry?.();
										});
								})}
						/>
					{/if}
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
						{#if directionalFrequency}
							{#await directionalFrequency}
								<RecordPending {locale} answer={directionalFrequency} shape={tableShape} />
							{:then result}
								{#if result.kind === 'answer' && 'cells' in result.answer && result.answer.cells.some((cell) => cell.state === 'measured' && typeof cell.key.direction === 'number')}
									<p class="text-small text-muted-foreground">
										{t(
											'Each row shows the direction with the most scheduled trips at that time.',
											'Chaque ligne du tableau indique la direction qui compte le plus de trajets prévus à ces heures.',
										)}
									</p>
									{@render timetable(result.answer)}
								{:else if result.kind === 'busy'}
									<RecordPending {locale} busy shape={tableShape} />
								{:else if result.kind === 'answer'}
									<p>
										{t(
											'Planned frequency by direction is unavailable.',
											'La fréquence prévue par direction est indisponible.',
										)}
									</p>
								{:else if !unavailable}
									<RecordUnavailable
										{locale}
										retry={result.kind === 'unreachable' ? result.retry : undefined}
									/>
								{/if}
							{/await}
						{:else}
							{@render timetable()}
						{/if}
					{:else if !unavailable}
						<p>
							{frequency && frequency.state !== 'measured'
								? frequency.state_text[locale]
								: t('No timetable for this day type', 'Aucun horaire pour ce type de jour')}
						</p>
					{/if}
				{/if}
			</div>
		</div>
		{#snippet evidence()}
			{#if frequency}<LineRecordEvidence evidence={frequency.evidence} {locale} />{/if}
		{/snippet}
	</RecordCard>
</div>
