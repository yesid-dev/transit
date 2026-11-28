<script lang="ts">
	import { getChartContext } from 'layerchart';
	import { cn } from '#lib/utils/index.ts';
	import { HEATMAP_COLOUR_LEVELS, heatmapTierClass } from '../heatmapTiers';
	import { goodToBadStep } from '../../goodToBadScale';

	export interface HeatmapCellDatum {
		key: string;
		c: number;
		r: number;
		tier: number | null;
	}
	let {
		cells,
		worstTier,
		worstGlyph = '',
	}: {
		cells: readonly HeatmapCellDatum[];
		worstTier: number;
		worstGlyph?: string;
	} = $props();

	const ctx = getChartContext();
	const bw = $derived(
		typeof (ctx.xScale as { bandwidth?: () => number })?.bandwidth === 'function'
			? (ctx.xScale as { bandwidth: () => number }).bandwidth()
			: 0,
	);
	const bh = $derived(
		typeof (ctx.yScale as { bandwidth?: () => number })?.bandwidth === 'function'
			? (ctx.yScale as { bandwidth: () => number }).bandwidth()
			: 0,
	);
	const px = (c: number): number => (ctx.xScale(c) as number) ?? 0;
	const py = (r: number): number => (ctx.yScale(r) as number) ?? 0;
	const glyphSize = $derived(Math.max(6, Math.min(bw, bh) * 0.7));
</script>

{#each cells as d, index (d.key)}
	{@const level = d.tier === null ? undefined : HEATMAP_COLOUR_LEVELS[d.tier]}
	<rect
		fill={level === undefined ? 'var(--dataviz-heatmap-nodata)' : goodToBadStep(level).fill}
		data-chart-datum={index}
		x={px(d.c)}
		y={py(d.r)}
		width={bw}
		height={bh}
		rx="1"
		class={cn(
			'dv-heatmap-cell',
			heatmapTierClass(d.tier),
			d.tier === worstTier && 'dv-heatmap-worst',
		)}
	></rect>
{/each}
{#if worstGlyph}
	{#each cells as d (d.key)}
		{#if d.tier === worstTier}
			<text
				class="dv-heatmap-glyph"
				fill={goodToBadStep(HEATMAP_COLOUR_LEVELS[worstTier] ?? 4).ink}
				x={px(d.c) + bw / 2}
				y={py(d.r) + bh / 2}
				font-size={glyphSize}
				text-anchor="middle"
				dominant-baseline="central"
				aria-hidden="true">{worstGlyph}</text
			>
		{/if}
	{/each}
{/if}
