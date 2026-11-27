<script lang="ts">
	import { getChartContext } from 'layerchart';

	let { values, axis = 'x' }: { values: readonly (number | string)[]; axis?: 'x' | 'y' } = $props();
	const chart = getChartContext();
	const boundaries = $derived.by(() => {
		const scale = axis === 'x' ? chart.xScale : chart.yScale;
		const length = axis === 'x' ? chart.width : chart.height;
		const half =
			'bandwidth' in scale && typeof scale.bandwidth === 'function' ? scale.bandwidth() / 2 : 0;
		const points = values
			.map((value, index) => ({
				position: Number(scale(value)) + half,
				index,
			}))
			.filter(({ position }) => Number.isFinite(position))
			.sort((a, b) => a.position - b.position);
		return points.map(({ position, index }, i) => ({
			index,
			start: i === 0 ? 0 : (points[i - 1].position + position) / 2,
			end: i === points.length - 1 ? length : (position + points[i + 1].position) / 2,
		}));
	});
</script>

{#each boundaries as { index, start, end } (index)}
	<rect
		data-chart-datum={index}
		x={axis === 'x' ? start : 0}
		y={axis === 'y' ? start : 0}
		width={Math.max(0, axis === 'x' ? end - start : chart.width)}
		height={Math.max(0, axis === 'y' ? end - start : chart.height)}
		fill="transparent"
	/>
{/each}
