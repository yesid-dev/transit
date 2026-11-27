<script lang="ts">
	import ChartDetails from '#lib/components/dataviz/chart/ChartDetails.svelte';
	import ChartPlotTargets from '#lib/components/dataviz/chart/ChartPlotTargets.svelte';
	import {
		ChartAxis,
		ChartBarSeries,
		ChartFrame,
		ChartLegend,
		ChartLineSeries,
		type ChartPoint,
		type ChartTick,
	} from '@yesid/ui/chart';

	let {
		title,
		seriesLabel,
		points,
		ticks,
		yMax,
		format,
		kind = 'bar',
	}: {
		title: string;
		seriesLabel: string;
		points: readonly (ChartPoint & { heading: string; value: string; sample?: string })[];
		ticks: readonly ChartTick[];
		yMax: number;
		format: (value: number) => string;
		kind?: 'bar' | 'line';
	} = $props();
	const readings = $derived(
		points.map((point) => ({
			key: String(point.x),
			heading: point.heading,
			rows: [
				{ label: seriesLabel, value: point.value },
				...(point.sample ? [{ label: '', value: point.sample }] : []),
			],
		})),
	);
	const yTicks = $derived([0, yMax / 2, yMax].map((value) => ({ value, label: format(value) })));
	const domain = $derived<[number, number]>([
		Math.min(...points.map(({ x }) => x)) - 0.5,
		Math.max(...points.map(({ x }) => x)) + 0.5,
	]);
</script>

{#if points.some(({ y }) => y !== null)}
	<ChartDetails label={title} {readings}>
		<ChartFrame label={title} xDomain={domain} yDomain={[0, yMax]}>
			{#snippet children(plot)}
				<ChartAxis {plot} axis="x" {ticks} />
				<ChartAxis {plot} axis="y" ticks={yTicks} />
				{#if kind === 'line'}
					<ChartLineSeries {plot} {points} />
				{:else}
					<ChartBarSeries {plot} {points} bandWidth={0.7} />
				{/if}
				<ChartPlotTargets {plot} positions={points.map(({ x }) => x)} />
			{/snippet}
			{#snippet legend()}
				<ChartLegend label={title} items={[{ kind, label: seriesLabel }]} />
			{/snippet}
		</ChartFrame>
	</ChartDetails>
{/if}
