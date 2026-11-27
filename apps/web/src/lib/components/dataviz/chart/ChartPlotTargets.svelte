<script lang="ts">
	import type { ChartPlot } from '@yesid/ui/chart';

	let { plot, positions }: { plot: ChartPlot; positions: readonly number[] } = $props();
</script>

{#each positions as x, index (index)}
	{@const previous = positions[index - 1]}
	{@const next = positions[index + 1]}
	{@const left = previous === undefined ? plot.left : plot.x((previous + x) / 2)}
	{@const right = next === undefined ? plot.right : plot.x((next + x) / 2)}
	<rect
		data-chart-datum={index}
		x={left}
		y={plot.top}
		width={Math.max(0, right - left)}
		height={plot.bottom - plot.top}
		fill="transparent"
	/>
{/each}
