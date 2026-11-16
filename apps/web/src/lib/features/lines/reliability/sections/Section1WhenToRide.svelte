<script lang="ts">
	import { csvCount, downloadCsv, type CsvContext, type CsvSource } from '../recordCsv';
	import { timeRows } from '../recordCsvModels';
	import { chartRows, CHART_COLUMNS } from '../chartCsv';
	import CsvDownload from './CsvDownload.svelte';
	import type { Locale } from '#lib/i18n/index.ts';
	import { absenceShort } from '#lib/site/absence.ts';
	import { fmtNumber, fmtPct } from '#lib/utils/index.ts';
	import { fmtLocalePct } from '#lib/utils/format.ts';
	import { SectionLabel } from '@yesid/ui/brand';
	import CollapsibleSection from './CollapsibleSection.svelte';
	import { ChartLegend } from '#lib/components/dataviz/index.ts';
	import { Chart } from '#lib/components/dataviz/chart/index.ts';
	import Detail from '#lib/components/shared/Detail.svelte';
	import MetricInfo from '#lib/features/metrics/MetricInfo.svelte';
	import {
		shiftLabel as shiftGrainLabel,
		shiftLabelShort as shiftGrainLabelShort,
		severeShareToSeverity,
		DAY_TYPE_GRAIN_ORDER,
		SHIFT_GRAIN_ORDER,
		SEVERE_DOMAIN,
	} from '#lib/features/reliability/shiftGrains.ts';
	import { selectPunctualityTimeOfDay } from '../selectors/punctualityTimeOfDay';
	import { selectPunctualityCrosstab } from '../selectors/punctualityCrosstab';
	import { selectWeekdayCycle } from '../selectors/weekdayCycle';
	import { buildHabitsHeatmap } from '#lib/reliability/habitsHeatmap.ts';
	import { selectRelativeScorePeak } from '../selectors/relativeScorePeak';
	import { selectShiftBars } from '../selectors/shiftBars';
	import { selectTimeOfDay, type CutScope, type ShareRow } from '../selectors/evidence';
	import { scopeDates } from '../recordDates';
	import type { PunctualityVM, HabitsVM } from '../clusters';
	import type { ReliabilityCopy } from '../reliability.copy';
	import { habitsBandCopy } from '../Cluster05Habits.copy';

	interface Section1WhenToRideProps {
		exportContext?: CsvContext;
		exportSource?: CsvSource;
		punctuality: PunctualityVM;
		habits: HabitsVM;
		/** Which days the published time-of-day cut covers. */
		scope: CutScope;
		locale: Locale;
		copy: ReliabilityCopy;
	}
	let {
		punctuality,
		habits,
		scope,
		locale,
		copy,
		exportContext,
		exportSource,
	}: Section1WhenToRideProps = $props();

	const band = $derived(habitsBandCopy[locale]);
	const e = $derived(copy.evidence);
	const t = $derived(copy.evidence.timeOfDay);
	const noDataLabel = $derived(absenceShort('no-observations', locale));
	const shown = $derived(scope.kind !== 'none');

	const pct = (v: number | null | undefined): string | null => fmtPct(v);
	const share = (v: number) => fmtLocalePct(v, locale, { rounding: 'round' })!;
	const count = (v: number) => fmtNumber(v, { locale, rounding: 'round' })!;
	const periodName = (key: string) => (t.periods as Record<string, string>)[key] ?? key;

	// One measure, the record's own: the share of readings on time, for the cut's own days.
	const timeOfDay = $derived(
		selectTimeOfDay(punctuality.peakOffPeak.byShift, punctuality.peakOffPeak.byDayType),
	);
	const dates = $derived(scopeDates(scope, locale, e.history));
	const summary = $derived.by(() => {
		if (!shown) return e.summaryAbsent;
		const spread = timeOfDay.spread;
		if (spread)
			return t.summary(
				share(spread.low),
				share(spread.high),
				spread.lowest.map(periodName).join(t.and),
			);
		const only = timeOfDay.periods.find((row) => row.percent != null);
		return only ? t.summaryOne(periodName(only.key), share(only.percent!)) : e.summaryAbsent;
	});
	const hasRows = $derived(
		shown && [...timeOfDay.periods, ...timeOfDay.dayTypes].some((row) => row.percent != null),
	);

	const shiftLabel = (g: string): string => shiftGrainLabel(g, locale);
	const dayTypeLabel = (g: string): string =>
		g === 'weekday' ? copy.peak.weekday : g === 'weekend' ? copy.peak.weekend : g;

	const hasHeatmap = $derived(!habits.isEmpty);
	const fullDayLabels = $derived(band.weekdays.slice(1));
	const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`;
	const relativePeak = $derived(
		selectRelativeScorePeak(habits, { fullRowLabels: fullDayLabels, hourLabel }),
	);
	const relativePeakText = $derived(
		relativePeak ? band.relativePeak(relativePeak.dayLabel, relativePeak.hourLabel) : null,
	);
	const heatmapSpec = $derived(
		buildHabitsHeatmap(habits.matrix, locale, {
			title: band.heatmapLabel,
			valueLabel: band.cellValueLabel,
			rowAxisLabel: band.dayAxisLabel,
			colAxisLabel: band.hourAxisLabel,
			rowLabels: band.weekdaysShort,
			fullRowLabels: fullDayLabels,
			tierLabels: band.tiers.labels,
			noDataLabel,
			worstGlyph: band.tiers.worstGlyph,
			hourLabel,
			hourTicks: [0, 3, 6, 9, 12, 15, 18, 21],
		}),
	);
	const legendItems = $derived([
		...band.tiers.labels.map((label, index) => ({
			colorVar: `var(--dataviz-heatmap-tier-${index})`,
			label: index === 3 ? `${label} ${band.tiers.worstGlyph}` : label,
			swatch: 'square' as const,
		})),
		{ colorVar: 'var(--dataviz-heatmap-nodata)', label: noDataLabel, swatch: 'square' as const },
	]);
	const scaleCaptionText = $derived(
		habits.scale
			? `${band.scaleLegend[habits.scale] ?? band.heatmapHeading} · ${band.scaleCaption}`
			: band.scaleCaption,
	);

	const timeOfDaySpec = $derived(
		selectPunctualityTimeOfDay(punctuality, locale, {
			title: copy.peak.strip.ariaLabel,
			unit: copy.units.pct,
			shiftLabel,
		}),
	);
	const hasShiftStrip = $derived(shown && timeOfDaySpec.kind === 'dot-strip');
	const shiftMeanLabel = $derived(
		timeOfDaySpec.kind === 'dot-strip' && timeOfDaySpec.medianRef != null
			? copy.peak.strip.mean(pct(timeOfDaySpec.medianRef) ?? noDataLabel)
			: '',
	);

	const dayTypeRows = $derived(
		punctuality.peakOffPeak.byDayType
			.filter((r) => r.severePct != null)
			.sort(
				(a, b) =>
					(DAY_TYPE_GRAIN_ORDER as readonly string[]).indexOf(a.grain) -
					(DAY_TYPE_GRAIN_ORDER as readonly string[]).indexOf(b.grain),
			),
	);
	const dayTypeBars = $derived(
		selectShiftBars(
			dayTypeRows.map((r) => ({
				key: r.grain,
				label: dayTypeLabel(r.grain),
				value: r.severePct,
				severity: severeShareToSeverity(r.severePct),
			})),
			locale,
			{
				title: copy.peak.dayType,
				rowLabel: copy.crosstab.dayTypeHeader,
				xLabel: copy.strip.severePct,
				unit: '%',
				domain: SEVERE_DOMAIN,
				noDataMarker: noDataLabel,
			},
		),
	);
	const hasPeak = $derived(shown && (hasShiftStrip || dayTypeRows.length > 0));

	const crosstabLines = $derived(
		selectPunctualityCrosstab(punctuality.byShiftDaytype, locale, {
			title: copy.crosstab.heading,
			xLabel: copy.crosstab.shiftHeader,
			yLabel: copy.strip.otpPct,
			shiftLabel: (s) => shiftGrainLabelShort(s, locale),
			weekdayLabel: copy.peak.weekday,
			weekendLabel: copy.peak.weekend,
		}),
	);
	const weekdayCycle = $derived(
		selectWeekdayCycle(punctuality.dayOfWeek, locale, {
			title: band.weekdayHeading,
			xLabel: band.dayAxisLabel,
			yLabel: copy.strip.avgDelayMin,
			unit: ' min',
			weekdayShort: (iso) => band.weekdaysShort[iso - 1],
		}),
	);
	const hasCrosstab = $derived(shown && crosstabLines.hasData);
	const hasWeekday = $derived(shown && weekdayCycle.hasData);
	const hasDetail = $derived(hasHeatmap || hasPeak || hasCrosstab || hasWeekday);
	const source = $derived(exportSource ? { ...exportSource, scope } : undefined);
	const timeCsv = $derived(
		downloadCsv(
			exportContext,
			hasRows ? source : undefined,
			'time-of-day',
			['group', 'period_key', 'period', 'on_time_pct'],
			timeRows(timeOfDay, periodName),
		),
	);
	const peakCsv = $derived(
		downloadCsv(exportContext, hasPeak ? source : undefined, 'peak-and-day-type', CHART_COLUMNS, [
			...chartRows(timeOfDaySpec, 'severe_readings_by_period').map((row) => ({
				...row,
				readings: csvCount(
					punctuality.peakOffPeak.byShift.findLast((r) => r.grain === row.cells[0])
						?.observationCount,
				),
				readingsBasis: 'published_period_observations',
			})),
			...chartRows(dayTypeBars, 'severe_readings_by_day_type').map((row) => ({
				...row,
				readings: csvCount(dayTypeRows.find((r) => r.grain === row.cells[0])?.observationCount),
				readingsBasis: 'published_day_type_observations',
			})),
		]),
	);
	const crosstabCsv = $derived(
		downloadCsv(
			exportContext,
			hasCrosstab ? source : undefined,
			'period-day-type',
			CHART_COLUMNS,
			chartRows(crosstabLines.spec, 'on_time_share_by_period_and_day_type').map((row) => ({
				...row,
				readings: csvCount(
					punctuality.byShiftDaytype.findLast(
						(cell) =>
							cell.shift === SHIFT_GRAIN_ORDER[Number(row.cells[0])] &&
							cell.day_type === (row.cells[2] === copy.peak.weekday ? 'weekday' : 'weekend'),
					)?.observation_count,
				),
				readingsBasis: 'on_time_share',
			})),
		),
	);
	const weekdayCsv = $derived(
		downloadCsv(
			exportContext,
			hasWeekday ? source : undefined,
			'weekday-delay',
			[...CHART_COLUMNS, 'source_observation_count'],
			chartRows(weekdayCycle.spec, 'average_delay_by_weekday').map((row) => ({
				...row,
				cells: [
					...row.cells,
					csvCount(
						punctuality.dayOfWeek.findLast(
							(cell) => cell.day_of_week_iso === Number(row.cells[0]) + 1,
						)?.observation_count,
					),
				],
			})),
		),
	);
	const relativeCsv = $derived(
		downloadCsv(
			exportContext,
			exportSource ? { ...exportSource, scope: { kind: 'history' } } : undefined,
			'relative-pattern',
			[...CHART_COLUMNS, 'scale'],
			hasHeatmap
				? chartRows(heatmapSpec, 'row_relative_problem_score').map((row) => ({
						...row,
						cells: [...row.cells, habits.scale],
					}))
				: [],
		),
	);
</script>

{#snippet shareRow(row: ShareRow)}
	<tr data-key={row.key}>
		<th scope="row">{periodName(row.key)}</th>
		<td class="n">
			{#if row.percent == null}
				<span class="evidence-absent" data-slot="absent-value">{e.notPublished}</span>
			{:else}
				<span class="tod-share">
					<span class="tod-bar" aria-hidden="true" style:--share={`${row.percent}%`}></span>
					{share(row.percent)}
				</span>
			{/if}
		</td>
		<td class="n">{row.readings == null ? '' : count(row.readings)}</td>
	</tr>
{/snippet}

<CollapsibleSection dataSection="when-to-ride" title={copy.sections.whenToRide.label} {summary}>
	<div class="evidence-body">
		{#if hasRows}
			<CsvDownload file={timeCsv} label={copy.sections.whenToRide.label} {copy} />
			<table class="evidence-table" data-slot="time-of-day">
				<caption
					>{t.caption}. {#if dates}{e.scope(dates)}{/if}</caption
				>
				<thead>
					<tr>
						<th scope="col">{t.columns.period}</th>
						<th scope="col" class="n">{t.columns.onTime}</th>
						<th scope="col" class="n">{t.columns.readings}</th>
					</tr>
				</thead>
				<tbody>
					{#each timeOfDay.periods as row (row.key)}{@render shareRow(row)}{/each}
				</tbody>
				{#if timeOfDay.dayTypes.length > 0}
					<tbody>
						<tr class="group"><th scope="rowgroup" colspan="3">{t.dayType}</th></tr>
						{#each timeOfDay.dayTypes as row (row.key)}{@render shareRow(row)}{/each}
					</tbody>
				{/if}
			</table>
		{:else}
			<p data-slot="when-to-ride-empty">
				<span class="evidence-absent" data-slot="absent-value"
					>{scope.kind === 'none' && scope.range ? t.absentRange : e.notPublished}</span
				>
			</p>
		{/if}

		{#if hasDetail}
			<Detail label={copy.sections.detailShow} labelOpen={copy.sections.detailHide}>
				{#if hasPeak}
					<div class="block" data-slot="peak-off-peak" data-card>
						<CsvDownload file={peakCsv} label={copy.peak.heading} {copy} />
						<span class="label-with-info">
							<SectionLabel text={copy.peak.heading} variant="metric" />
							<MetricInfo
								class="cluster-info"
								metricKey="severe"
								{locale}
								name={copy.peak.heading}
								side="bottom"
							/>
						</span>
						{#if dates}<p class="caption" data-slot="peak-scope">{e.scope(dates)}</p>{/if}
						{#if hasShiftStrip}
							<div class="strip" data-slot="shift-severe-strip">
								<Chart spec={timeOfDaySpec} />
								<p class="caption" data-slot="shift-strip-axis">
									{copy.peak.dayOfWeekSevere}{#if shiftMeanLabel}
										· {shiftMeanLabel}{/if}
								</p>
							</div>
						{/if}
						{#if dayTypeRows.length > 0}
							<div class="strip" data-slot="peak-day-type">
								<SectionLabel text={copy.peak.dayType} variant="metric" />
								<Chart spec={dayTypeBars} />
							</div>
						{/if}
						<p class="caption" data-slot="peak-caveat">{copy.peak.caveat}</p>
					</div>
				{/if}

				{#if hasCrosstab}
					<div class="block" data-slot="shift-daytype-crosstab" data-card>
						<CsvDownload file={crosstabCsv} label={copy.crosstab.heading} {copy} />
						<span class="label-with-info">
							<SectionLabel text={copy.crosstab.heading} variant="metric" />
							<MetricInfo
								class="cluster-info"
								metricKey="otp"
								{locale}
								name={copy.crosstab.heading}
								side="bottom"
							/>
						</span>
						<Chart spec={crosstabLines.spec} />
						<p class="caption" data-slot="crosstab-caption">
							{copy.crosstab.caption}
							{#if dates}{e.scope(dates)}{/if}
						</p>
					</div>
				{/if}

				{#if hasWeekday}
					<div class="block" data-slot="habits-weekday" data-card>
						<CsvDownload file={weekdayCsv} label={band.weekdayHeading} {copy} />
						<span class="label-with-info">
							<SectionLabel text={band.weekdayHeading} variant="metric" />
							<MetricInfo
								class="cluster-info"
								metricKey="seasonality"
								{locale}
								name={band.weekdayHeading}
								side="bottom"
							/>
						</span>
						<Chart spec={weekdayCycle.spec} />
						<p class="caption" data-slot="habits-cycle-caption">
							{band.cycle.captionSingle}
							{#if dates}{e.scope(dates)}{/if}
						</p>
					</div>
				{/if}

				{#if hasHeatmap}
					<div class="block" data-slot="habits-heatmap" data-card>
						<CsvDownload file={relativeCsv} label={t.pattern} {copy} />
						<span class="label-with-info">
							<SectionLabel text={t.pattern} variant="metric" />
							<MetricInfo
								class="cluster-info"
								metricKey="habits"
								{locale}
								name={t.pattern}
								side="bottom"
							/>
						</span>
						{#if relativePeakText}
							<p class="heatmap-insight" data-slot="best-time-insight">{relativePeakText}</p>
						{/if}
						<p class="caption" data-slot="heatmap-window-note">{t.patternNote}</p>
						<div class="habits-heatmap">
							<Chart spec={heatmapSpec} />
						</div>
						<ChartLegend items={legendItems} />
						<p class="caption" data-slot="habits-scale-caption">{scaleCaptionText}</p>
					</div>
				{/if}
			</Detail>
		{/if}
	</div>
</CollapsibleSection>

<style>
	.block,
	.strip {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.block :global(.habits-heatmap) {
		max-width: 100%;
	}
	.caption {
		margin: 0;
		font-family: var(--font-mono);
		font-size: var(--text-small);
		line-height: 1.4;
		color: var(--muted-foreground);
	}
	.heatmap-insight {
		margin: 0;
		font-size: var(--text-body);
		line-height: 1.45;
		font-weight: 500;
		color: var(--foreground);
		text-wrap: pretty;
	}
	/* The bar sits beside the printed share; the number is the value, the bar only its size. */
	.tod-share {
		display: inline-flex;
		align-items: center;
		justify-content: end;
		gap: 0.5rem;
	}
	.tod-bar {
		position: relative;
		display: inline-block;
		inline-size: clamp(2.5rem, 12vw, 6rem);
		block-size: 0.5rem;
		border-radius: var(--radius-pill);
		background: color-mix(in srgb, var(--foreground) 10%, transparent);
		overflow: hidden;
	}
	.tod-bar::after {
		content: '';
		position: absolute;
		inset-block: 0;
		inset-inline-start: 0;
		inline-size: var(--share);
		background: var(--dataviz-status-on-time);
	}
	/* The bar is decoration beside the printed share: a narrow card keeps the room for names. */
	@container line-evidence (max-width: 24rem) {
		.tod-bar {
			display: none;
		}
	}
</style>
