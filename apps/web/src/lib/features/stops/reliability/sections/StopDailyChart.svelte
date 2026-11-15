<script lang="ts">
	import { Button } from '@yesid/ui/button';
	import { intl, type Locale } from '#lib/i18n/index.ts';
	import { transitTerms } from '#lib/i18n/transitTerms.copy.ts';
	import { fmtLocalePct } from '#lib/utils/format.ts';
	import type { DayByDay, DayByDayRow } from '../selectors/dailyTrend';
	import { longDay as dayName } from '../selectors/dayByDayText';
	import type { StopReliabilityCopy } from '../stops-reliability.copy';

	interface StopDailyChartProps {
		view: DayByDay;
		/** "November 4 to 10, 2026" for the caption and the table. */
		dates: string;
		locale: Locale;
		copy: StopReliabilityCopy;
	}

	let { view, dates, locale, copy }: StopDailyChartProps = $props();
	const t = $derived(copy.dayByDay);
	const id = $props.id();
	let tableOpen = $state(false);

	const rows = $derived(view.rows);
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
	const at = (date: string) => new Date(`${date}T12:00:00Z`);
	const weekday = (date: string) =>
		intl.dateTime(locale, { weekday: 'short', timeZone: 'UTC' }).format(at(date));
	const longDay = (date: string) => dayName(date, locale);
	const pct = (value: number | null) => fmtLocalePct(value, locale);
	const count = (value: number | null) =>
		value == null ? null : intl.number(locale).format(value);
	const gapText = (row: DayByDayRow) => (row.gap === 'no-readings' ? t.noReadings : t.notPublished);
</script>

<div class="stop-day-chart-wrap" data-slot="stop-daily">
	<figure class="stop-day-chart" data-fit={fit}>
		<figcaption class="stop-day-chart__cap">{t.caption(dates)}</figcaption>
		<div class="stop-day-chart__frame">
			<span class="stop-day-chart__rule" style:--v="0" aria-hidden="true"></span>
			<span
				class="stop-day-chart__rule stop-day-chart__rule--faint"
				style:--v="50"
				aria-hidden="true"
			></span>
			<span class="stop-day-chart__tick" style:--v="100" aria-hidden="true">100</span>
			<span class="stop-day-chart__tick" style:--v="50" aria-hidden="true">50</span>
			<span class="stop-day-chart__tick" style:--v="0" aria-hidden="true">0</span>
			<ol class="stop-day-chart__cols" style:--count={rows.length}>
				{#each rows as row, index (row.date)}
					<li
						style:--v={row.percent ?? 0}
						data-gap={row.percent == null || undefined}
						data-tick={index % 7 === 0 || index === rows.length - 1 || undefined}
					>
						<span class="sr-only">{longDay(row.date)}: {pct(row.percent) ?? gapText(row)}</span>
						<span class="stop-day-chart__bar" aria-hidden="true"></span>
						<span class="stop-day-chart__x" aria-hidden="true">
							<span class="stop-day-chart__weekday">{weekday(row.date)}</span>
							<span>{Number(row.date.slice(8))}</span>
						</span>
						<span class="stop-day-chart__v" aria-hidden="true">{pct(row.percent) ?? ''}</span>
					</li>
				{/each}
			</ol>
		</div>
	</figure>

	<div class="stop-day-chart__actions">
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
	<!-- A labelled region that scrolls on its own when a phone is too narrow for the columns;
	     focusable so a keyboard can scroll it (WCAG scrollable region). -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div
		class="stop-day-table"
		id={`${id}-table`}
		hidden={!tableOpen}
		role="region"
		aria-labelledby={`${id}-caption`}
		tabindex="0"
	>
		<table>
			<caption id={`${id}-caption`}>{t.tableCaption(dates)}</caption>
			<thead>
				<tr>
					<th scope="col">{t.columns.day}</th>
					<th scope="col" class="n">{t.columns.share}</th>
					<th scope="col" class="n">{t.columns.readings}</th>
					<th scope="col" class="n">{t.columns.late}</th>
				</tr>
			</thead>
			<tbody>
				{#each rows as row (row.date)}
					<tr>
						<th scope="row">{longDay(row.date)}</th>
						<td class="n">{pct(row.percent) ?? gapText(row)}</td>
						<td class="n">{count(row.readings) ?? gapText(row)}</td>
						<td class="n">{count(row.lateReadings) ?? gapText(row)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>

<style>
	.stop-day-chart-wrap {
		display: grid;
		gap: 0.75rem;
		min-width: 0;
	}
	.stop-day-chart {
		--plot-h: 132px;
		--gut: 2.25rem;
		container: stop-day-chart / inline-size;
		display: grid;
		gap: 0.75rem;
		margin: 0;
	}
	.stop-day-chart__cap {
		font-size: var(--text-small);
		font-weight: 500;
		color: var(--foreground);
	}
	.stop-day-chart__frame {
		position: relative;
		padding-inline-start: var(--gut);
	}
	.stop-day-chart__rule {
		position: absolute;
		inset-inline: var(--gut) 0;
		top: calc(var(--plot-h) * (100 - var(--v)) / 100);
		border-top: 1px solid var(--muted-foreground);
		pointer-events: none;
	}
	.stop-day-chart__rule--faint {
		border-top-color: var(--border-subtle);
	}
	.stop-day-chart__tick {
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
	.stop-day-chart__cols {
		display: grid;
		grid-template-columns: repeat(var(--count), minmax(0, 1fr));
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.stop-day-chart__cols > li {
		display: grid;
		grid-template-rows: var(--plot-h) auto auto;
		justify-items: center;
		min-width: 0;
	}
	.stop-day-chart__bar {
		align-self: end;
		width: min(24px, 58%);
		height: calc(var(--plot-h) * var(--v) / 100);
		border-radius: 4px 4px 0 0;
		background: var(--muted-foreground);
	}
	/* A day without a share: a hollow mark on the axis, never a zero-height bar. */
	li[data-gap] .stop-day-chart__bar {
		width: 10px;
		height: 10px;
		margin-bottom: -5px;
		border: 2px solid var(--muted-foreground);
		border-radius: 50%;
		background: transparent;
	}
	.stop-day-chart__x {
		display: grid;
		justify-items: center;
		padding-top: 6px;
		color: var(--muted-foreground);
		font-size: var(--text-caption);
		line-height: 1.25;
		font-variant-numeric: tabular-nums;
	}
	.stop-day-chart__v {
		padding-top: 4px;
		color: var(--foreground);
		font-size: var(--text-small);
		font-weight: 600;
		line-height: 1.3;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	/* A printed value needs about 60 px of column (a French "57,1 %" is 52 px), a weekday name less:
	   both show only when the chart's own width gives every column that room, never shrunk or
	   clipped. Screen readers and the table always have every value. Past 7 columns, day numbers
	   mark each week until there is room for all of them. */
	.stop-day-chart__v,
	.stop-day-chart__weekday,
	.stop-day-chart:is([data-fit='xl'], [data-fit='none']) li:not([data-tick]) .stop-day-chart__x {
		visibility: hidden;
	}
	@container stop-day-chart (min-width: 14rem) {
		.stop-day-chart[data-fit='s'] :is(.stop-day-chart__v, .stop-day-chart__weekday) {
			visibility: visible;
		}
	}
	@container stop-day-chart (min-width: 21rem) {
		.stop-day-chart[data-fit='m'] :is(.stop-day-chart__v, .stop-day-chart__weekday) {
			visibility: visible;
		}
	}
	@container stop-day-chart (min-width: 23.5rem) {
		.stop-day-chart[data-fit='xl'] li:not([data-tick]) .stop-day-chart__x {
			visibility: visible;
		}
	}
	@container stop-day-chart (min-width: 29rem) {
		.stop-day-chart[data-fit='l'] :is(.stop-day-chart__v, .stop-day-chart__weekday) {
			visibility: visible;
		}
	}
	@container stop-day-chart (min-width: 40rem) {
		.stop-day-chart {
			--plot-h: 168px;
		}
	}
	@container stop-day-chart (min-width: 55rem) {
		.stop-day-chart[data-fit='xl'] :is(.stop-day-chart__v, .stop-day-chart__weekday) {
			visibility: visible;
		}
	}
	.stop-day-chart__actions {
		margin-top: 0.25rem;
	}
	.stop-day-table {
		max-width: 100%;
		overflow-x: auto;
	}
	.stop-day-table table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--text-small);
		font-variant-numeric: tabular-nums;
	}
	.stop-day-table caption {
		padding-bottom: 0.5rem;
		font-weight: 500;
		text-align: start;
	}
	.stop-day-table th,
	.stop-day-table td {
		padding: 0.5rem 0.75rem 0.5rem 0;
		border-bottom: 1px solid var(--border-subtle);
		text-align: start;
		vertical-align: top;
	}
	.stop-day-table thead th {
		color: var(--muted-foreground);
		font-weight: 500;
	}
	.stop-day-table tbody th {
		font-weight: 400;
	}
	/* Words never break inside: the page allows breaks anywhere, a day name must not. */
	.stop-day-table :is(th, td, caption) {
		overflow-wrap: normal;
		word-break: normal;
	}
	.stop-day-table .n {
		text-align: end;
		white-space: nowrap;
	}
	/* Column names wrap between words, so a long French heading never starves the day column. */
	.stop-day-table thead th.n {
		white-space: normal;
	}
	.stop-day-table:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}
	@media (forced-colors: active) {
		.stop-day-chart__bar {
			background: CanvasText;
		}
	}
</style>
