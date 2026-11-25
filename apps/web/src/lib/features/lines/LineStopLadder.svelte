<script lang="ts">
	import { SegmentedChoice } from '@yesid/ui/brand';
	import { StopLadder } from '@yesid/ui/chart';
	import { localizeHref, type Locale } from '#lib/i18n/index.ts';
	import StateMark from '#lib/features/record/StateMark.svelte';
	import { choose } from '#lib/features/record/recordText.ts';
	import { stopLadderChart, chartState } from '#lib/features/record/charts/recordCharts.ts';
	import type { RecordSeries } from '#lib/server/engine.ts';
	import { carryFrameState } from '#lib/site/frameState.ts';
	import { countedUnit, minuteReading } from '#lib/site/presenter.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { routeFor } from '#lib/nav/index.ts';
	import { delayBuilds } from './lineRecordText.ts';
	import LineReadingTable from './LineReadingTable.svelte';

	let {
		series,
		title,
		locale,
		headsigns,
		stopNames,
		stopCodes,
		pinned,
		city,
		table,
	}: {
		series: RecordSeries;
		title: string;
		locale: Locale;
		headsigns: Record<number, string>;
		stopNames: Record<string, string>;
		stopCodes: Record<string, string>;
		pinned: URL;
		city: string;
		table: boolean;
	} = $props();
	const t = (en: string, fr: string) => choose(locale, en, fr);
	const { directionLabel } = transitDisplay();
	const ids = $derived([...new Set(series.cells.map(({ key }) => String(key.direction)))].sort());
	const options = $derived(
		ids.map((id) => ({ key: id, label: directionLabel(id, headsigns, locale) })),
	);
	let selected = $state<string>();
	const direction = $derived(selected && ids.includes(selected) ? selected : ids[0]);
	const rows = $derived(
		series.cells
			.filter(({ key }) => String(key.direction) === direction)
			.toSorted((a, b) => Number(a.key.stop_sequence) - Number(b.key.stop_sequence)),
	);
	const reading = $derived(
		stopLadderChart({ ...series, cells: rows }, title, locale, (id) => ({
			name: stopNames[id] ?? id,
			code: stopCodes[id],
			href: stopNames[id]
				? carryFrameState(localizeHref(routeFor({ kind: 'stop', id }), locale, city), pinned)
				: undefined,
		})),
	);
	const threshold = { value: 300, label: t('5 minutes late', '5 minutes de retard') };
	const stretch = $derived(delayBuilds(rows));
	const from = $derived(stretch ? reading.props.stops[stretch.from] : undefined);
	const to = $derived(stretch ? reading.props.stops[stretch.to] : undefined);
	const highlight = $derived(
		from && to
			? { fromId: from.id, toId: to.id, label: t('Where delay builds', 'Où le retard augmente') }
			: undefined,
	);
	const peak = $derived(
		reading.props.stops.reduce<(typeof reading.props.stops)[number] | undefined>(
			(highest, stop) =>
				stop.value != null && (highest?.value == null || stop.value > highest.value)
					? stop
					: highest,
			undefined,
		),
	);
</script>

{#if stretch && from && to}
	{@const stops = countedUnit(stretch.to - stretch.from + 1, 'stop', locale)}
	<p class="mb-3">
		{t(
			`Median delay rises by ${minuteReading(stretch.seconds / 60, locale)} over ${stops} between ${from.name} and ${to.name}.`,
			`Le retard médian augmente de ${minuteReading(stretch.seconds / 60, locale)} sur ${stops} entre ${from.name} et ${to.name}.`,
		)}
	</p>
{:else if peak}
	<p class="mb-3">
		{t(
			`The highest measured median delay was at ${peak.name} (${peak.valueLabel}).`,
			`Le retard médian mesuré le plus élevé était à l’arrêt ${peak.name} (${peak.valueLabel}).`,
		)}
	</p>
{:else}
	<p class="mb-3"><StateMark state={chartState(series.state)} {locale} /></p>
{/if}
{#if options.length > 1 && direction}
	<div class="mb-3">
		<SegmentedChoice
			{options}
			value={direction}
			label={t('Stop ladder direction', 'Direction du profil des arrêts')}
			variant="fit-row"
			onSelect={(id) => (selected = id)}
		/>
	</div>
{/if}
<div id="line-stop-ladder">
	{#if table}
		<LineReadingTable
			{title}
			{locale}
			headers={[reading.props.columns.stop, reading.props.columns.value]}
			rows={reading.props.stops.map((stop) => ({
				label: stop.name,
				href: stop.href,
				values: [stop.valueLabel],
			}))}
		/>
	{:else if reading.props.stops.length}
		<StopLadder
			{...reading.props}
			max={Math.max(threshold.value, reading.props.max)}
			{threshold}
			{highlight}
		/>
	{/if}
</div>
