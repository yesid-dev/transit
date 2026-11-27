<script lang="ts">
	import ChartDetails from '../ChartDetails.svelte';
	import LayerChartTargets from '../LayerChartTargets.svelte';
	import { chartDatumValue } from '#lib/site/presenter.ts';
	import { Chart as LcChart, Svg, Spline, Points, Highlight } from 'layerchart';
	import { scaleLinear, scalePoint } from 'd3-scale';
	import { curveMonotoneX } from 'd3-shape';
	import { cn } from '#lib/utils/index.ts';
	import type { SparklineSpec } from '../ChartSpec';

	export interface SparklineMarkProps {
		spec: SparklineSpec;
		class?: string;
	}

	let { spec, class: className }: SparklineMarkProps = $props();

	const color = $derived(spec.colorVar ?? 'var(--dataviz-status-on-time)');
	const width = $derived(spec.width ?? 96);
	const widthCss = $derived(typeof width === 'number' ? `${width}px` : width);
	const height = $derived(spec.height ?? 24);

	type Row = { _i: number; x: string; y: number | null };
	const rows = $derived<Row[]>(
		spec.values.map((y, i) => ({ _i: i, x: spec.xLabels?.[i] ?? String(i + 1), y })),
	);
	const yDomain = $derived<[number, number]>([spec.domain[0], spec.domain[1]]);
	const lastReal = $derived.by<Row | null>(() => {
		for (let i = rows.length - 1; i >= 0; i--) {
			const r = rows[i];
			if (r && r.y != null) return r;
		}
		return null;
	});

	const num = (v: number | null): string => (v == null ? '·' : String(v));
	const summary = $derived(
		lastReal ? `${spec.label}: ${num(lastReal.y)}${spec.unit}` : `${spec.label}: ·`,
	);
	const reading = (value: number | null | undefined) =>
		chartDatumValue(value, spec.unit, spec.locale);
	const readings = $derived(
		rows.map((row) => ({
			key: String(row._i),
			heading: row.x,
			rows: [{ label: spec.label, value: reading(row.y), colorVar: color }],
		})),
	);
</script>

<ChartDetails label={spec.title} {readings}>
	<figure
		class={cn('dv-sparkline m-0 inline-block', className)}
		aria-label={summary}
		data-slot="sparkline-mark"
		data-ripple-exempt
		style:width={width === '100%' ? '100%' : undefined}
		style:max-width="100%"
	>
		<div
			class="dv-sparkline-plot"
			style:width={widthCss}
			style:max-width="100%"
			style:height={`${height}px`}
		>
			<LcChart
				data={rows}
				x={(d: Row) => d.x}
				y={(d: Row) => d.y ?? yDomain[0]}
				xScale={scalePoint()}
				xDomain={rows.map((r) => r.x)}
				yScale={scaleLinear()}
				{yDomain}
				padding={{ top: 3, right: 3, bottom: 3, left: 3 }}
				tooltipContext={{ mode: 'band' }}
			>
				<Svg>
					<Spline
						y={(d: Row) => d.y ?? yDomain[0]}
						curve={curveMonotoneX}
						defined={(d: Row) => d.y != null}
						style={`stroke:${color}`}
						class="dv-sparkline-spline"
					/>
					{#if spec.showLast && lastReal}
						<Points data={[lastReal]} r={2.5} style={`fill:${color}`} class="dv-sparkline-last" />
					{/if}
					<Highlight points />
					<LayerChartTargets values={rows.map((row) => row.x)} />
				</Svg>
			</LcChart>
		</div>

		<table class="sr-only">
			<caption>{spec.title}</caption>
			<tbody>
				{#each rows as r (r._i)}
					<tr><th scope="row">{r.x}</th><td>{num(r.y)}{r.y == null ? '' : spec.unit}</td></tr>
				{/each}
			</tbody>
		</table>
	</figure>
</ChartDetails>

<style>
	:global(.dv-sparkline-spline) {
		fill: none;
		stroke-width: 1.5;
	}
</style>
