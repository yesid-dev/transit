<script lang="ts">
	import { downloadCsv, type CsvContext, type CsvSource } from '../recordCsv';
	import { dailyRows } from '../recordCsvModels';
	import CsvDownload from './CsvDownload.svelte';
	import { Button } from '@yesid/ui/button';
	import { intl, type Locale } from '#lib/i18n/index.ts';
	import { transitTerms } from '#lib/i18n/transitTerms.copy.ts';
	import { fmtDelayMin, fmtNumber } from '#lib/utils/index.ts';
	import { fmtLocalePct } from '#lib/utils/format.ts';
	import { VERDICT_RELIABLE_FLOOR } from '#lib/v1/verdict.ts';
	import { formatRecordDates } from '../recordDates';
	import type { DailyOnTime } from '../selectors/punctualityTrend';
	import type { ReliabilityCopy } from '../reliability.copy';

	interface DailyOnTimeChartProps {
		exportContext?: CsvContext;
		exportSource?: CsvSource;
		daily: DailyOnTime;
		locale: Locale;
		copy: ReliabilityCopy;
	}

	let { daily, locale, copy, exportContext, exportSource }: DailyOnTimeChartProps = $props();
	const t = $derived(copy.record.daily);
	const id = $props.id();
	let tableOpen = $state(false);

	const rows = $derived(daily.rows);
	const file = $derived(
		downloadCsv(
			exportContext,
			exportSource && rows.length
				? {
						...exportSource,
						scope:
							exportSource.scope.kind === 'none'
								? exportSource.scope
								: { kind: 'window', from: rows[0].date, to: rows[rows.length - 1].date },
					}
				: undefined,
			'day-by-day',
			['date', 'on_time_pct', 'average_delay_min'],
			dailyRows(daily),
		),
	);
	const dates = $derived(
		rows.length ? formatRecordDates(rows[0].date, rows[rows.length - 1].date, locale) : null,
	);
	/** Column-count group: how much chart width every column needs for its printed labels. */
	const fit = $derived(
		rows.length <= 3
			? 's'
			: rows.length <= 5
				? 'm'
				: rows.length <= 7
					? 'l'
					: rows.length <= 14
						? 'xl'
						: 'none',
	);
	const weekday = (date: string) =>
		intl
			.dateTime(locale, { weekday: 'short', timeZone: 'UTC' })
			.format(new Date(`${date}T00:00:00Z`));
	const longDay = (date: string) => formatRecordDates(date, date, locale) ?? date;
	const pct = (value: number | null) => fmtLocalePct(value, locale);
	const reference = VERDICT_RELIABLE_FLOOR;
</script>

<div class="day-chart-wrap" data-slot="otp-trend">
	<figure class="day-chart" data-fit={fit}>
		<figcaption class="day-chart__cap">{dates ? t.caption(dates) : t.title}</figcaption>
		<div class="day-chart__frame">
			<span class="day-chart__rule" style:--v="0" aria-hidden="true"></span>
			<span class="day-chart__rule day-chart__rule--ref" style:--v={reference} aria-hidden="true"
			></span>
			<span class="day-chart__tick" style:--v="100" aria-hidden="true">100</span>
			<span class="day-chart__tick day-chart__tick--ref" style:--v={reference} aria-hidden="true"
				>{reference}</span
			>
			<span class="day-chart__tick" style:--v="0" aria-hidden="true">0</span>
			<ol class="day-chart__cols" style:--count={rows.length}>
				{#each rows as row, index (row.date)}
					<li
						style:--v={row.percent ?? 0}
						data-gap={row.percent == null || undefined}
						data-tick={index % 7 === 0 || index === rows.length - 1 || undefined}
					>
						<span class="sr-only">{longDay(row.date)}: {pct(row.percent) ?? t.gap}</span>
						<span class="day-chart__bar" aria-hidden="true"></span>
						<span class="day-chart__x" aria-hidden="true">
							<span class="day-chart__weekday">{weekday(row.date)}</span>
							<span>{Number(row.date.slice(8))}</span>
						</span>
						<span class="day-chart__v" aria-hidden="true">{pct(row.percent) ?? ''}</span>
					</li>
				{/each}
			</ol>
		</div>
		<p class="day-chart__key">{t.reference}</p>
	</figure>

	<div class="day-chart__actions">
		<CsvDownload {file} label={t.title} {copy} />
		<Button
			variant="outline"
			size="sm"
			class="min-h-11"
			aria-expanded={tableOpen}
			aria-controls={`${id}-table`}
			onclick={() => (tableOpen = !tableOpen)}
		>
			{tableOpen ? t.hideTable : transitTerms[locale].action.viewTable}
		</Button>
	</div>
	<div class="day-table" id={`${id}-table`} hidden={!tableOpen}>
		<table>
			<caption>{dates ? t.tableCaption(dates) : t.title}</caption>
			<thead>
				<tr>
					<th scope="col">{t.columns.day}</th>
					<th scope="col" class="n">{t.columns.onTime}</th>
					<th scope="col" class="n">{t.columns.readings}</th>
					<th scope="col" class="n">{t.columns.avgDelay}</th>
				</tr>
			</thead>
			<tbody>
				{#each rows as row (row.date)}
					<tr>
						<th scope="row">{longDay(row.date)}</th>
						<td class="n">{pct(row.percent) ?? t.gap}</td>
						<td class="n">{fmtNumber(row.readings, { locale, rounding: 'round' }) ?? t.gap}</td>
						<td class="n">{fmtDelayMin(row.avgDelayMin, { locale, rounding: 'auto' }) ?? t.gap}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>

<style>
	.day-chart-wrap {
		display: grid;
		gap: 0.75rem;
		min-width: 0;
	}
	.day-chart {
		--plot-h: 132px;
		--gut: 2.25rem;
		container: day-chart / inline-size;
		display: grid;
		gap: 0.75rem;
		margin: 0;
	}
	.day-chart__cap {
		font-size: var(--text-small);
		font-weight: 500;
		color: var(--foreground);
	}
	.day-chart__frame {
		position: relative;
		padding-inline-start: var(--gut);
	}
	.day-chart__rule {
		position: absolute;
		inset-inline: var(--gut) 0;
		top: calc(var(--plot-h) * (100 - var(--v)) / 100);
		border-top: 1px solid var(--muted-foreground);
		pointer-events: none;
	}
	.day-chart__rule--ref {
		border-top: 2px dashed var(--foreground);
		opacity: 0.85;
	}
	.day-chart__tick {
		position: absolute;
		inset-inline-start: 0;
		top: calc(var(--plot-h) * (100 - var(--v)) / 100);
		width: calc(var(--gut) - 6px);
		transform: translateY(-50%);
		color: var(--muted-foreground);
		font-size: var(--text-caption);
		font-variant-numeric: tabular-nums;
		line-height: 1;
		text-align: end;
	}
	.day-chart__tick--ref {
		color: var(--foreground);
		font-weight: 600;
	}
	.day-chart__cols {
		display: grid;
		grid-template-columns: repeat(var(--count), minmax(0, 1fr));
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.day-chart__cols > li {
		display: grid;
		grid-template-rows: var(--plot-h) auto auto;
		justify-items: center;
		min-width: 0;
	}
	.day-chart__bar {
		align-self: end;
		width: min(24px, 58%);
		height: calc(var(--plot-h) * var(--v) / 100);
		border-radius: 4px 4px 0 0;
		background: var(--muted-foreground);
	}
	/* A day without a published share: a hollow mark on the axis, never a zero-height bar. */
	li[data-gap] .day-chart__bar {
		width: 10px;
		height: 10px;
		margin-bottom: -5px;
		border: 2px solid var(--muted-foreground);
		border-radius: 50%;
		background: transparent;
	}
	.day-chart__x {
		display: grid;
		justify-items: center;
		padding-top: 6px;
		color: var(--muted-foreground);
		font-size: var(--text-caption);
		line-height: 1.25;
		font-variant-numeric: tabular-nums;
	}
	.day-chart__v {
		padding-top: 4px;
		color: var(--foreground);
		font-size: var(--text-small);
		font-weight: 600;
		line-height: 1.3;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	/* A printed value needs about 60 px of column (a French "89,8 %" is 52 px), a weekday name less:
	   both show only when the chart's own width gives every column that room, never shrunk or
	   clipped. Screen readers and the table always have every value. Past 7 columns, day numbers
	   mark each week until there is room for all of them. */
	.day-chart__v,
	.day-chart__weekday,
	.day-chart:is([data-fit='xl'], [data-fit='none']) li:not([data-tick]) .day-chart__x {
		visibility: hidden;
	}
	@container day-chart (min-width: 14rem) {
		.day-chart[data-fit='s'] :is(.day-chart__v, .day-chart__weekday) {
			visibility: visible;
		}
	}
	@container day-chart (min-width: 21rem) {
		.day-chart[data-fit='m'] :is(.day-chart__v, .day-chart__weekday) {
			visibility: visible;
		}
	}
	@container day-chart (min-width: 23.5rem) {
		.day-chart[data-fit='xl'] li:not([data-tick]) .day-chart__x {
			visibility: visible;
		}
	}
	@container day-chart (min-width: 29rem) {
		.day-chart[data-fit='l'] :is(.day-chart__v, .day-chart__weekday) {
			visibility: visible;
		}
	}
	@container day-chart (min-width: 40rem) {
		.day-chart {
			--plot-h: 168px;
		}
	}
	@container day-chart (min-width: 55rem) {
		.day-chart[data-fit='xl'] :is(.day-chart__v, .day-chart__weekday) {
			visibility: visible;
		}
	}
	.day-chart__key {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0;
		color: var(--muted-foreground);
		font-size: var(--text-small);
	}
	.day-chart__key::before {
		content: '';
		flex: none;
		width: 22px;
		border-top: 2px dashed var(--foreground);
		opacity: 0.85;
	}
	.day-chart__actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.25rem;
	}
	.day-table {
		max-width: 100%;
		overflow-x: auto;
	}
	.day-table table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--text-small);
		font-variant-numeric: tabular-nums;
	}
	.day-table caption {
		padding-bottom: 0.5rem;
		font-weight: 500;
		text-align: start;
	}
	.day-table th,
	.day-table td {
		padding: 0.5rem 0.75rem 0.5rem 0;
		border-bottom: 1px solid var(--border-subtle);
		text-align: start;
		vertical-align: top;
	}
	.day-table thead th {
		color: var(--muted-foreground);
		font-weight: 500;
	}
	.day-table tbody th {
		font-weight: 400;
	}
	.day-table .n {
		text-align: end;
		white-space: nowrap;
	}
	@media (forced-colors: active) {
		.day-chart__bar {
			background: CanvasText;
		}
	}
</style>
