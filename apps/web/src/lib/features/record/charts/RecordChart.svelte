<script lang="ts">
	import {
		BandBar,
		HourGrid,
		ChartAxis,
		ChartFrame,
		ChartLegend,
		ChartLineSeries,
	} from '@yesid/ui/chart';
	import { StatusMark } from '@yesid/ui/brand';
	import { DataTable, type DataTableColumn } from '@yesid/ui/table';
	import { type Locale } from '#lib/i18n/index.ts';
	import type { RecordCell, RecordSeries } from '#lib/server/engine.ts';
	import { choose, tally } from '../recordText.ts';
	import StateMark from '../StateMark.svelte';
	import { bandChart, chartState, hourChart, trendChart, type ChartTable } from './recordCharts.ts';

	type Input =
		| { kind: 'bands'; answer: RecordCell }
		| { kind: 'hours'; answer: RecordSeries }
		| { kind: 'trend'; answer: RecordSeries; network?: RecordSeries };

	let {
		input,
		title,
		locale,
		table = false,
		id,
	}: {
		input: Input;
		title: string;
		locale: Locale;
		table?: boolean;
		id: string;
	} = $props();
	const reading = $derived(
		input.kind === 'bands'
			? { kind: input.kind, ...bandChart(input.answer, title, locale) }
			: input.kind === 'hours'
				? { kind: input.kind, ...hourChart(input.answer, title, locale) }
				: { kind: input.kind, ...trendChart(input.answer, title, locale, input.network) },
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

<div {id} class="grid min-w-0 gap-2">
	{#if table && reading.table.rows.length}
		<DataTable
			caption={title}
			{columns}
			rows={reading.table.rows}
			key={(row) => row.id}
			responsive={{ mode: 'scroll', minWidth: '28rem' }}
			pageSize={reading.table.pageSize}
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
		<BandBar {...reading.props} rows={false}>
			{#snippet absent()}<StateMark state={chartState(input.answer.state)} {locale} />{/snippet}
		</BandBar>
		<dl class="grid gap-2">
			{#each reading.props.bands as band (band.id)}
				<div
					class="flex flex-wrap justify-between gap-2 border-b border-border pb-2 last:border-b-0"
				>
					<dt><StatusMark status={band.status} label={band.label} /></dt>
					<dd class="ml-auto text-right tabular-nums">
						<strong>{band.valueLabel}</strong>
						<span class="block text-small text-muted-foreground">{band.detail}</span>
					</dd>
				</div>
			{/each}
		</dl>
	{:else if reading.kind === 'hours'}
		{#if reading.props.columns.length}
			<p class="text-small text-muted-foreground">{reading.props.scale.label}</p>
			<HourGrid {...reading.props} />
		{:else}
			<StateMark state={chartState(input.answer.state)} {locale} />
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
					<text
						class="trend-end"
						x={Math.min(plot.right, plot.x(last.x) + plot.unit * 0.4)}
						y={plot.y(last.y) < plot.top + plot.unit
							? plot.y(last.y) + plot.unit
							: plot.y(last.y) - plot.unit * 0.4}
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
