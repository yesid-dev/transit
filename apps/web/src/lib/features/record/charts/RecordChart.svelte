<script lang="ts">
	import {
		HourGrid,
		StopLadder,
		type StopLadderStop,
		ChartAxis,
		ChartBarSeries,
		ChartFrame,
		ChartLegend,
		ChartLineSeries,
	} from '@yesid/ui/chart';
	import { StatusMark } from '@yesid/ui/brand';
	import { DataTable, type DataTableColumn } from '@yesid/ui/table';
	import { type Locale } from '#lib/i18n/index.ts';
	import type { DelayDistribution, RecordCell, RecordSeries } from '#lib/server/engine.ts';
	import { countedUnit } from '#lib/site/presenter.ts';
	import { choose, tally } from '../recordText.ts';
	import StateMark from '../StateMark.svelte';
	import RecordBandBar from './RecordBandBar.svelte';
	import {
		bandChart,
		chartState,
		histogramChart,
		hourChart,
		stopLadderChart,
		trendChart,
		type ChartTable,
	} from './recordCharts.ts';

	type Input =
		| { kind: 'bands'; answer: RecordCell }
		| { kind: 'hours'; answer: RecordSeries }
		| {
				kind: 'ladder';
				answer: RecordSeries;
				stop: (id: string) => Pick<StopLadderStop, 'name' | 'code' | 'href' | 'timingPoint'>;
				observed?: boolean;
		  }
		| { kind: 'histogram'; answer: DelayDistribution }
		| { kind: 'trend'; answer: RecordSeries; network?: RecordSeries };

	let {
		input,
		title,
		locale,
		table = false,
		id,
		fill = false,
		formatShare,
	}: {
		input: Input;
		title: string;
		locale: Locale;
		table?: boolean;
		id: string;
		fill?: boolean;
		formatShare?: (value: number, locale: Locale) => string;
	} = $props();
	const reading = $derived(
		input.kind === 'bands'
			? { kind: input.kind, ...bandChart(input.answer, title, locale, formatShare) }
			: input.kind === 'hours'
				? { kind: input.kind, ...hourChart(input.answer, title, locale, formatShare) }
				: input.kind === 'ladder'
					? {
							kind: input.kind,
							...stopLadderChart(input.answer, title, locale, input.stop, input.observed),
						}
					: input.kind === 'histogram'
						? { kind: input.kind, ...histogramChart(input.answer, title, locale, formatShare) }
						: {
								kind: input.kind,
								...trendChart(input.answer, title, locale, input.network, formatShare),
							},
	);
	const t = (en: string, fr: string) => choose(locale, en, fr);
	type Row = ChartTable['rows'][number];
	const columns = $derived<DataTableColumn<Row>[]>([
		{ key: 'label', header: reading.table.columns.label, rowHeader: true, cell: name },
		{ key: 'value', header: reading.table.columns.value, numeric: true, cell: value },
		...(reading.table.columns.detail
			? [
					{
						key: 'detail',
						header: reading.table.columns.detail,
						numeric: true,
						cell: detail,
					},
				]
			: []),
	]);
</script>

{#snippet name(row: Row)}{row.label}{/snippet}
{#snippet value(row: Row)}{row.value}{/snippet}
{#snippet detail(row: Row)}{row.detail ?? ''}{/snippet}

<div {id} class="grid min-w-0 gap-2" class:grow={fill}>
	{#if table && reading.table.rows.length}
		<DataTable
			caption={title}
			{columns}
			rows={reading.table.rows}
			key={(row) => row.id}
			responsive={{ mode: 'scroll', minWidth: '28rem' }}
			pageSize={reading.table.pageSize && reading.table.rows.length > reading.table.pageSize
				? reading.table.pageSize
				: undefined}
			pageLabels={{
				showing: (shown, total) =>
					t(
						`Showing ${tally(shown, locale)} of ${tally(total, locale)}`,
						`${tally(shown, locale)} sur ${tally(total, locale)}`,
					),
				more: (count) =>
					t(`Show ${tally(count, locale)} more`, `Afficher ${tally(count, locale)} de plus`),
			}}
		/>
	{:else if reading.kind === 'bands'}
		<RecordBandBar {...reading.props}>
			{#snippet absent()}<StateMark state={chartState(input.answer.state)} {locale} />{/snippet}
		</RecordBandBar>
	{:else if reading.kind === 'ladder'}
		<StopLadder {...reading.props} />
	{:else if reading.kind === 'hours'}
		{#if reading.props.columns.length}
			<HourGrid {...reading.props} />
		{:else}
			<StateMark state={chartState(input.answer.state)} {locale} />
		{/if}
	{:else if reading.kind === 'histogram'}
		{#if reading.props.points.length}
			<div class="flex flex-wrap justify-between gap-x-2 gap-y-1 text-small">
				{#each reading.props.bands as band (band.status)}
					<StatusMark status={band.status} label={band.label} />
				{/each}
			</div>
			<ChartFrame
				class="sm:min-h-96"
				label={reading.props.label}
				xDomain={reading.props.xDomain}
				yDomain={reading.props.yDomain}
			>
				{#snippet children(plot)}
					<ChartAxis
						{plot}
						axis="y"
						ticks={plot.left < 2.5 * plot.unit
							? reading.props.yTicks.map((tick) =>
									tick.value === 0 ? tick : { ...tick, label: tick.label.replace(/\s*%$/u, '') },
								)
							: reading.props.yTicks}
					/>
					<ChartAxis {plot} axis="x" ticks={reading.props.ticks} />
					<ChartBarSeries {plot} points={reading.props.points} bandWidth={1} />
					{#each reading.props.boundaries as x (x)}
						<ChartLineSeries
							{plot}
							points={reading.props.yDomain.map((y) => ({ x, y }))}
							reference
						/>
					{/each}
				{/snippet}
				{#snippet legend()}
					<p class="text-right text-small text-muted-foreground">{reading.props.axis}</p>
				{/snippet}
			</ChartFrame>
		{:else}
			<StateMark state={chartState(input.answer.state)} {locale} />
			{#if input.kind === 'histogram' && input.answer.state === 'too_few_to_judge'}
				{@const observed = input.answer.evidence.counts.classified}
				{@const minimum = input.answer.info?.[0]?.minimum_sample}
				{#if observed != null && minimum != null}
					<p class="text-small text-muted-foreground">
						{countedUnit(observed, 'event', locale)} · minimum {tally(minimum, locale)}
					</p>
				{/if}
			{/if}
		{/if}
	{:else if reading.props.points.some(({ y }) => y !== null) || reading.props.reference.some(({ y }) => y !== null)}
		<ChartFrame
			label={reading.props.label}
			xDomain={reading.props.xDomain}
			yDomain={reading.props.yDomain}
		>
			{#snippet children(plot)}
				<ChartAxis {plot} axis="x" ticks={reading.props.ticks} />
				<ChartAxis {plot} axis="y" ticks={reading.props.yTicks} />
				<ChartLineSeries {plot} points={reading.props.points} />
				{#if reading.props.reference.length}
					<ChartLineSeries
						{plot}
						points={reading.props.reference.length === 1
							? reading.props.xDomain.map((x) => ({ x, y: reading.props.reference[0].y }))
							: reading.props.reference}
						reference
					/>
				{/if}
				{#if reading.props.last}
					{@const last = reading.props.last}
					{@const lastIndex = reading.props.points.findIndex(({ x }) => x === last.x)}
					{@const previous = reading.props.points[lastIndex - 1]?.y}
					{@const pointY = plot.y(last.y)}
					{@const below =
						pointY < plot.top + plot.unit ||
						(previous != null && previous > last.y && pointY + plot.unit <= plot.bottom)}
					<text
						class="trend-end"
						x={Math.min(plot.right, plot.x(last.x) + plot.unit * 0.4)}
						y={below ? pointY + plot.unit : pointY - plot.unit * 0.4}
						text-anchor="end">{last.label}</text
					>
				{/if}
			{/snippet}
			{#snippet legend()}
				<ChartLegend
					label={title}
					items={[
						{ kind: 'line', label: reading.table.columns.value },
						...(reading.table.columns.detail
							? [{ kind: 'reference' as const, label: reading.table.columns.detail }]
							: []),
					]}
				/>
			{/snippet}
		</ChartFrame>
	{:else}
		<StateMark state={chartState(input.answer.state)} {locale} />
	{/if}
</div>

<style>
	.trend-end {
		fill: var(--foreground);
		font-family: var(--font-mono);
		font-size: var(--text-caption);
	}
</style>
