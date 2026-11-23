<script lang="ts">
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
		points: readonly ChartPoint[];
		ticks: readonly ChartTick[];
		yMax: number;
		format: (value: number) => string;
		kind?: 'bar' | 'line';
	} = $props();
	const yTicks = $derived([0, yMax / 2, yMax].map((value) => ({ value, label: format(value) })));
	const domain = $derived<[number, number]>([
		Math.min(...points.map(({ x }) => x)) - 0.5,
		Math.max(...points.map(({ x }) => x)) + 0.5,
	]);
</script>

{#if points.some(({ y }) => y !== null)}
	<ChartFrame label={title} xDomain={domain} yDomain={[0, yMax]}>
		{#snippet children(plot)}
			<ChartAxis {plot} axis="x" {ticks} />
			<ChartAxis {plot} axis="y" ticks={yTicks} />
			{#if kind === 'line'}
				<ChartLineSeries {plot} {points} />
			{:else}
				<ChartBarSeries {plot} {points} bandWidth={0.7} />
			{/if}
		{/snippet}
		{#snippet legend()}
			<ChartLegend label={title} items={[{ kind, label: seriesLabel }]} />
		{/snippet}
	</ChartFrame>
{/if}
