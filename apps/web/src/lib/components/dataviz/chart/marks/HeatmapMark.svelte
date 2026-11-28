<script lang="ts">
	import ChartDetails from '../ChartDetails.svelte';
	import { chartDatumValue } from '#lib/site/presenter.ts';
	import { Chart as LcChart, Svg, Axis } from 'layerchart';
	import { scaleBand } from 'd3-scale';
	import { cn } from '#lib/utils/index.ts';
	import ChartFrame from '../ChartFrame.svelte';
	import ScrollFrame from '../ScrollFrame.svelte';
	import HeatmapCells from './HeatmapCells.svelte';
	import { heatmapTier, HEATMAP_COLOUR_LEVELS, HEATMAP_WORST_TIER } from '../heatmapTiers';
	import { goodToBadStep } from '../../goodToBadScale';
	import type { HeatmapSpec } from '../ChartSpec';
	import { absenceShort } from '#lib/site/absence.ts';

	export interface HeatmapMarkProps {
		spec: HeatmapSpec;
		class?: string;
	}
	let { spec, class: className }: HeatmapMarkProps = $props();

	const rows = $derived(spec.rowLabels.length);
	const cols = $derived(spec.colLabels.length);
	const domain = $derived<[number, number]>([spec.domain?.[0] ?? 0, spec.domain?.[1] ?? 1]);
	const tierLabels = $derived(spec.tiers?.tierLabels ?? []);
	const noDataLabel = $derived(
		spec.tiers?.noDataLabel ?? absenceShort('no-observations', spec.locale),
	);
	const worstGlyph = $derived(spec.tiers?.worstGlyph ?? '');

	type FlatCell = {
		key: string;
		r: number;
		c: number;
		value: number | null;
		tier: number | null;
		rowLabel: string;
		fullRowLabel: string;
		colLabel: string;
		tierLabel: string;
		worst: boolean;
	};

	const fullRow = (r: number): string => spec.fullRowLabels?.[r] ?? spec.rowLabels[r] ?? `${r}`;
	const tierText = (tier: number | null): string =>
		tier == null ? noDataLabel : (tierLabels[tier] ?? `${tier}`);

	const data = $derived.by<FlatCell[]>(() => {
		const out: FlatCell[] = [];
		for (let r = 0; r < rows; r++) {
			for (let c = 0; c < cols; c++) {
				const value = spec.cells[r]?.[c]?.value ?? null;
				const tier = heatmapTier(value, domain);
				out.push({
					key: `${r}-${c}`,
					r,
					c,
					value,
					tier,
					rowLabel: spec.rowLabels[r] ?? `${r}`,
					fullRowLabel: fullRow(r),
					colLabel: spec.colLabels[c] ?? `${c}`,
					tierLabel: tierText(tier),
					worst: tier === HEATMAP_WORST_TIER,
				});
			}
		}
		return out;
	});

	const rowIdx = $derived(Array.from({ length: rows }, (_, i) => i));
	const colIdx = $derived(Array.from({ length: cols }, (_, i) => i));
	const tickIdx = $derived((spec.colTicks ?? []).map((t) => t.index));
	const tickLabel = (i: number): string =>
		(spec.colTicks ?? []).find((t) => t.index === i)?.label ?? '';

	const frameHeight = $derived(`${Math.max(3, rows) * 1.6 + 2.5}rem`);
	const gutterPadding = { top: 10, right: 0, bottom: 34, left: 44 };
	const cellPadding = { top: 10, right: 12, bottom: 34, left: 4 };
	const readings = $derived(
		data.map((cell) => ({
			key: cell.key,
			heading: cell.fullRowLabel + ' · ' + cell.colLabel,
			rows: [
				{
					label: spec.valueLabel ?? spec.title,
					value:
						cell.value == null
							? cell.tierLabel
							: chartDatumValue(
									spec.unit === '%' ? cell.value * 100 : cell.value,
									spec.unit ?? '',
									spec.locale,
								),
				},
				...(cell.value == null ? [] : [{ label: '', value: cell.tierLabel }]),
				...(spec.cells[cell.r]?.[cell.c]?.n == null
					? []
					: [
							{
								label: 'Observations',
								value: chartDatumValue(spec.cells[cell.r][cell.c].n, '', spec.locale),
							},
						]),
			],
		})),
	);
</script>

<figure
	class={cn('dv-heatmap-mark m-0', className)}
	aria-label={spec.title}
	data-slot="heatmap-mark"
>
	<ScrollFrame
		gutterWidth="3rem"
		scrollLabel={spec.colAxisLabel ?? spec.title}
		class="dv-heatmap-scroll"
	>
		{#snippet gutter()}
			<ChartFrame height={frameHeight} class="dv-heatmap-gutter">
				<LcChart
					data={[]}
					x={() => 0}
					xScale={scaleBand()}
					xDomain={[0]}
					y={(d: FlatCell) => d.r}
					yScale={scaleBand().padding(0.06)}
					yDomain={rowIdx}
					padding={gutterPadding}
				>
					<Svg>
						<Axis
							placement="left"
							ticks={rowIdx}
							format={(i: number) => spec.rowLabels[i] ?? ''}
							rule={false}
							class="dv-heatmap-axis"
						/>
					</Svg>
				</LcChart>
			</ChartFrame>
		{/snippet}
		{#snippet scroller()}
			<ChartDetails label={spec.title} {readings}>
				<ChartFrame height={frameHeight} class="dv-heatmap-cells">
					<LcChart
						{data}
						x={(d: FlatCell) => d.c}
						xScale={scaleBand().padding(0.06)}
						xDomain={colIdx}
						y={(d: FlatCell) => d.r}
						yScale={scaleBand().padding(0.06)}
						yDomain={rowIdx}
						padding={cellPadding}
						tooltipContext={{ mode: 'bounds', touchEvents: 'auto' }}
					>
						<Svg>
							<Axis
								placement="bottom"
								ticks={tickIdx}
								format={(i: number) => tickLabel(i)}
								rule={false}
								label={spec.colAxisLabel}
								labelPlacement="middle"
								class="dv-heatmap-axis"
							/>
							<HeatmapCells cells={data} worstTier={HEATMAP_WORST_TIER} {worstGlyph} />
						</Svg>
					</LcChart>
				</ChartFrame>
			</ChartDetails>
		{/snippet}
	</ScrollFrame>

	{#if tierLabels.length}
		<ul
			class="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-small"
			role="list"
			aria-label={spec.valueLabel ?? spec.title}
		>
			{#each HEATMAP_COLOUR_LEVELS as level, tier (level)}
				{#if tierLabels[tier]}
					<li class="flex items-center gap-2">
						<span
							class="size-4 rounded-sm"
							style:background-color={goodToBadStep(level).fill}
							aria-hidden="true"
						></span>
						{tierLabels[tier]}
					</li>
				{/if}
			{/each}
			<li class="flex items-center gap-2">
				<span
					class="size-4 rounded-sm"
					style:background-color="var(--dataviz-heatmap-nodata)"
					aria-hidden="true"
				></span>
				{noDataLabel}
			</li>
		</ul>
	{/if}

	<table class="sr-only">
		<caption>{spec.title}</caption>
		<thead>
			<tr>
				<th scope="col">{spec.rowAxisLabel ?? ''}</th>
				{#each spec.colLabels as col, c (c)}
					<th scope="col">{col}</th>
				{/each}
			</tr>
		</thead>
		<tbody>
			{#each rowIdx as r (r)}
				<tr>
					<th scope="row">{fullRow(r)}</th>
					{#each colIdx as c (c)}
						{@const tier = heatmapTier(spec.cells[r]?.[c]?.value ?? null, domain)}
						<td
							>{tier === HEATMAP_WORST_TIER && worstGlyph ? worstGlyph + ' ' : ''}{tierText(
								tier,
							)}</td
						>
					{/each}
				</tr>
			{/each}
		</tbody>
	</table>
</figure>

<style>
	/* 24 columns need room for 8 hour labels: on a narrow screen the cells scroll beside the
	   fixed day gutter instead of squeezing until the labels run together. The chart frame's own
	   min-width: 0 is more specific than a bare class, so this rule names the frame too. */
	.dv-heatmap-mark :global(.chart-frame.dv-heatmap-cells) {
		min-width: 27rem;
	}
	:global(rect.dv-heatmap-cell) {
		stroke: var(--card);
		stroke-width: 0.5;
	}
	:global(rect.dv-heatmap-worst) {
		stroke: var(--foreground);
		stroke-width: 1.25;
	}
	.dv-heatmap-glyph {
		pointer-events: none;
		font-family: var(--font-mono);
	}
	:global(.dv-heatmap-axis .tick text) {
		fill: var(--muted-foreground);
		font-family: var(--font-mono);
		font-size: var(--text-mono);
	}
	:global(.dv-heatmap-axis .axis-label),
	:global(.dv-heatmap-axis text.label) {
		fill: var(--muted-foreground);
		font-size: var(--text-mono);
	}
</style>
