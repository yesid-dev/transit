<script lang="ts">
	import ChartDetails from '#lib/components/dataviz/chart/ChartDetails.svelte';
	import { countedLabel, countedUnit, recordDate, recordPercent } from '#lib/site/presenter.ts';
	import { DayStrip } from '@yesid/ui/chart';
	import { intl, type Locale } from '#lib/i18n/index.ts';
	import type { RecordSeries } from '#lib/server/engine.ts';
	import { choose, measuredShare } from './recordText.ts';

	let {
		title,
		series,
		locale,
	}: {
		title: string;
		series: RecordSeries;
		locale: Locale;
	} = $props();

	const date = (day: string, options: Intl.DateTimeFormatOptions) =>
		intl.dateTime(locale, { ...options, timeZone: 'UTC' }).format(new Date(day));
	const days = $derived.by(() => {
		const byDay = new Map(series.cells.map((cell) => [cell.key.day, cell]));
		const missing = series.evidence.days_not_measured;
		const dates = new Set(
			[...missing, ...byDay.keys()].filter((day): day is string => typeof day === 'string'),
		);
		return [...dates].sort().map((day) => {
			const cell = byDay.get(day);
			const share = measuredShare(cell, 'on_time');
			const count = cell?.evidence.counts.classified;
			return {
				id: day,
				count,
				label: date(day, { day: 'numeric', month: 'short' }),
				dateLabel: date(day, { dateStyle: 'long' }),
				report: share === null ? null : { value: recordPercent(share, locale), fraction: share },
			};
		});
	});
</script>

{#if days.length}
	{@const measured = choose(locale, 'On-time share', 'Part à l’heure')}
	{@const missing = choose(locale, 'No measured share', 'Aucune part mesurée')}
	<ChartDetails
		label={title}
		targets="[data-slot='day-strip-cell']"
		readings={days.map((day) => ({
			key: day.id,
			heading: recordDate(day.id, locale),
			rows: [
				{ label: measured, value: day.report?.value ?? missing },
				...(day.count == null
					? []
					: [{ label: countedLabel(locale), value: countedUnit(day.count, 'event', locale) }]),
			],
		}))}
	>
		<DayStrip label={title} cells={days} reportedLabel={measured} missingLabel={missing} />
	</ChartDetails>
{/if}
