<script lang="ts">
	import ChartDetails from '../ChartDetails.svelte';
	import LayerChartTargets from '../LayerChartTargets.svelte';
	import { chartDatumValue } from '#lib/site/presenter.ts';
	import { Chart as LcChart, Svg, Bar, Points, Axis, Grid } from 'layerchart';
	import { scaleBand, scaleLinear } from 'd3-scale';
	import { cn } from '#lib/utils/index.ts';
	import ChartFrame from '../ChartFrame.svelte';
	import { categoryGutter } from '../axisGutter';
	import { structuralLabels } from '../structuralLabels';
	import type { DumbbellSpec, DumbbellDatum } from '../ChartSpec';
	import type { SeverityCode } from '#lib/v1/schemas/index.ts';

	export interface DumbbellMarkProps {
		spec: DumbbellSpec;
		class?: string;
	}

	let { spec, class: className }: DumbbellMarkProps = $props();

	const labels = $derived(spec.rows.map((r) => r.label));
	const reals = $derived(spec.rows.filter((r) => r.scheduled != null && r.observed != null));
	const xDomain = $derived<[number, number]>([spec.domain[0], spec.domain[1]]);
	const structure = $derived(structuralLabels(spec.locale));
	const layerStructureKey = $derived(
		JSON.stringify([
			spec.domain,
			spec.rows.map((row) => [
				row.key,
				row.label,
				row.scheduled == null || row.observed == null,
				row.severity ?? 'watch',
			]),
		]),
	);

	const obsBySeverity = (sev: SeverityCode): DumbbellDatum[] =>
		reals.filter((r) => (r.severity ?? 'watch') === sev);

	const schedOf = (d: DumbbellDatum) => d.scheduled ?? 0;
	const obsOf = (d: DumbbellDatum) => d.observed ?? 0;
	const yOf = (d: DumbbellDatum) => d.label;

	const frameHeight = $derived(`${Math.max(3, spec.rows.length) * 1.5 + 4}rem`);
	const gutter = $derived(categoryGutter(labels, { min: 88, max: 168 }));
	const padding = $derived({ top: 12, right: 18, bottom: 42, left: gutter.left });

	const fmt = (v: number | null | undefined): string => (v == null ? '' : String(v));
	const reading = (value: number | null | undefined) =>
		chartDatumValue(value, spec.unit, spec.locale);
	const readings = $derived(
		spec.rows.map((row) => ({
			key: row.key,
			heading: row.label,
			rows: [
				{ label: spec.scheduledLabel, value: reading(row.scheduled) },
				{ label: spec.observedLabel, value: reading(row.observed) },
				...(row.excess == null ? [] : [{ label: structure.gap, value: reading(row.excess) }]),
				...(row.note ? [{ label: '', value: row.note }] : []),
			],
		})),
	);
</script>

<figure class={cn('dv-dumbbell m-0', className)} aria-label={spec.title} data-slot="dumbbell-mark">
	<div class="dv-dumbbell-legend" aria-hidden="true">
		<span class="dv-dumbbell-key"
			><span class="dv-dumbbell-swatch sched"></span>{spec.scheduledLabel}</span
		>
		<span class="dv-dumbbell-key"
			><span class="dv-dumbbell-swatch obs"></span>{spec.observedLabel}</span
		>
	</div>

	<ChartDetails label={spec.title} {readings}>
		<ChartFrame height={frameHeight} class="dv-dumbbell-plot">
			{#key layerStructureKey}
				<LcChart
					data={reals}
					x={schedOf}
					y={yOf}
					xScale={scaleLinear().clamp(true)}
					{xDomain}
					yScale={scaleBand().padding(0.5)}
					yDomain={labels}
					{padding}
					tooltipContext={{ mode: 'band' }}
				>
					<Svg>
						<Grid x class="dv-dumbbell-grid" />
						<Axis
							placement="bottom"
							label={spec.xLabel}
							labelPlacement="middle"
							ticks={5}
							format={(v) => `${v}`}
							class="dv-dumbbell-axis"
						/>
						<Axis
							placement="left"
							rule={false}
							format={(l: string) => gutter.truncate(l)}
							class="dv-dumbbell-axis"
						/>
						{#each reals as row (row.key)}
							<Bar data={row} x1={obsOf} radius={2} class="dv-dumbbell-conn" />
						{/each}
						<Points r={4} class="dv-dumbbell-sched" />
						<Points data={obsBySeverity('watch')} x={obsOf} r={5} class="dv-dumbbell-obs-watch" />
						<Points data={obsBySeverity('high')} x={obsOf} r={5} class="dv-dumbbell-obs-high" />
						<Points
							data={obsBySeverity('critical')}
							x={obsOf}
							r={5}
							class="dv-dumbbell-obs-critical"
						/>
						<LayerChartTargets values={labels} axis="y" />
					</Svg>
				</LcChart>
			{/key}
		</ChartFrame>
	</ChartDetails>

	<table class="sr-only">
		<caption>{spec.title}</caption>
		<thead>
			<tr>
				<th scope="col">{structure.row}</th>
				<th scope="col">{spec.scheduledLabel}</th>
				<th scope="col">{spec.observedLabel}</th>
			</tr>
		</thead>
		<tbody>
			{#each spec.rows as r (r.key)}
				<tr data-key={r.key}>
					<th scope="row">{r.label}</th>
					<td>{fmt(r.scheduled)}</td>
					<td>{fmt(r.observed)}</td>
				</tr>
			{/each}
		</tbody>
	</table>
</figure>

<style>
	.dv-dumbbell-legend {
		display: flex;
		gap: var(--spacing-4, 1rem);
		margin-bottom: var(--spacing-1, 0.25rem);
		font-size: var(--text-mono);
		color: var(--muted-foreground);
	}
	.dv-dumbbell-key {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}
	.dv-dumbbell-swatch {
		width: 0.6rem;
		height: 0.6rem;
		border-radius: 50%;
	}
	.dv-dumbbell-swatch.sched {
		background: var(--muted-foreground);
	}
	.dv-dumbbell-swatch.obs {
		background: var(--dataviz-severity-high);
	}
	:global(rect.dv-dumbbell-conn) {
		fill: var(--border);
		opacity: 0.7;
	}
	:global(circle.dv-dumbbell-sched) {
		fill: var(--muted-foreground);
	}
	:global(circle.dv-dumbbell-obs-watch) {
		fill: var(--dataviz-severity-watch);
	}
	:global(circle.dv-dumbbell-obs-high) {
		fill: var(--dataviz-severity-high);
	}
	:global(circle.dv-dumbbell-obs-critical) {
		fill: var(--dataviz-severity-critical);
	}
	:global(.dv-dumbbell-axis .tick text) {
		fill: var(--muted-foreground);
		font-family: var(--font-mono);
		font-size: var(--text-mono);
	}
	:global(.dv-dumbbell-axis .axis-label),
	:global(.dv-dumbbell-axis text.label) {
		fill: var(--muted-foreground);
		font-size: var(--text-mono);
	}
	:global(.dv-dumbbell-grid line) {
		stroke: var(--border);
		opacity: 0.5;
	}
</style>
