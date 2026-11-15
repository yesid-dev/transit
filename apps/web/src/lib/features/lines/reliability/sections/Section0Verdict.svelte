<script lang="ts">
	import './reliability-sections.css';
	import { page } from '$app/state';
	import type { Locale } from '#lib/i18n/index.ts';
	import { transitTerms } from '#lib/i18n/transitTerms.copy.ts';
	import { fmtDelayMin, fmtNumber, fmtPct } from '#lib/utils/index.ts';
	import { fmtLocalePct } from '#lib/utils/format.ts';
	import { CollapsibleSection, SectionLabel } from '@yesid/ui/brand';
	import { Chart } from '#lib/components/dataviz/chart/index.ts';
	import { AbsentValue, MaybeValue } from '#lib/components/edge/index.ts';
	import Detail from '#lib/components/shared/Detail.svelte';
	import MetricInfo from '#lib/features/metrics/MetricInfo.svelte';
	import { SEVERE_DOMAIN } from '#lib/features/reliability/shiftGrains.ts';
	import { selectPunctualityDistribution } from '../selectors/punctualityDistribution';
	import { selectBullet } from '../selectors/bullet';
	import { recordLink, type LineRecord, type RecordCitation } from '../selectors/lineRecord';
	import type { DailyOnTime } from '../selectors/punctualityTrend';
	import { formatRecordDates } from '../recordDates';
	import {
		dailyPercentileCaption,
		type selectDailyPercentiles,
	} from '#lib/site/dailyPercentiles.ts';
	import type { PunctualityVM } from '../clusters';
	import type { ReliabilityCopy } from '../reliability.copy';
	import DailyOnTimeChart from './DailyOnTimeChart.svelte';
	import RecordCopyButton from './RecordCopyButton.svelte';

	interface Section0VerdictProps {
		vm: PunctualityVM;
		record: LineRecord;
		daily: DailyOnTime;
		locale: Locale;
		copy: ReliabilityCopy;
		mode?: 'day' | 'week' | 'month' | 'range';
		dailyPercentiles?: ReturnType<typeof selectDailyPercentiles>;
		citation?: RecordCitation;
	}
	let {
		vm,
		record,
		daily,
		locale,
		copy,
		mode = 'day',
		dailyPercentiles = null,
		citation,
	}: Section0VerdictProps = $props();

	const t = $derived(copy.record);
	const terms = $derived(transitTerms[locale]);
	const headline = $derived(vm.headline);
	const answer = $derived(record.answer);
	const period = $derived(record.period);
	const estimatedPercentiles = $derived(
		(headline.grain ?? mode) === 'week' || (headline.grain ?? mode) === 'month',
	);
	const pct = (value: number | null) => fmtLocalePct(value, locale, { rounding: 'round' });
	const minutes = (value: number | null) => fmtDelayMin(value, { locale, rounding: 'fixed1' });
	const count = (value: number) => fmtNumber(value, { locale, rounding: 'round' })!;

	const periodText = $derived.by(() => {
		if (!period) return null;
		const dates = formatRecordDates(period.from, period.to, locale);
		return dates ? t.period(dates, terms.completeDays(period.days, count(period.days))) : null;
	});
	const href = $derived(recordLink(page.url, citation?.providerId ?? null, period));
	const citationText = $derived.by(() => {
		if (!citation || !period || answer.kind !== 'figure') return null;
		const dates = formatRecordDates(period.from, period.to, locale, { year: true });
		return dates
			? t.citation({
					host: page.url.host,
					line: citation.line,
					provider: citation.providerName,
					figure: pct(answer.percent)!,
					dates,
					readings: answer.readings == null ? null : count(answer.readings),
					href,
				})
			: null;
	});

	// Zero readings have no average, percentile or share: those figures are withheld, never 0.
	const measured = $derived(headline.observationCount !== 0);
	const delays = $derived([
		{ key: 'avg', label: t.delays.avg, value: measured ? minutes(headline.avgDelayMin) : null },
		{ key: 'p50', label: copy.strip.p50Min, value: measured ? minutes(headline.p50Min) : null },
		{ key: 'p90', label: copy.strip.p90Min, value: measured ? minutes(headline.p90Min) : null },
	]);
	const dailySummary = $derived(
		daily.low && daily.high
			? t.daily.summary(
					fmtLocalePct(daily.low.percent, locale)!,
					fmtLocalePct(daily.high.percent, locale)!,
					formatRecordDates(daily.low.date, daily.low.date, locale) ?? daily.low.date,
				)
			: t.daily.summaryAbsent,
	);

	const distSpec = $derived(
		selectPunctualityDistribution(vm, locale, {
			title: copy.strip.delayDistHeading,
			unit: ' s',
			xLabel: copy.strip.delayDistLabel,
			yLabel: copy.strip.delayDistCount,
		}),
	);
	const hasDist = $derived(headline.p50Min != null || headline.p90Min != null);
	const severePct = $derived<number | null>(measured ? headline.severePct : null);
	const severeBullet = $derived(
		selectBullet(severePct, locale, {
			title: copy.strip.severePct,
			xLabel: copy.strip.severePct,
			unit: copy.units.pct,
			domain: SEVERE_DOMAIN,
			tone:
				severePct == null
					? 'neutral'
					: severePct >= 10
						? 'bad'
						: severePct >= 5
							? 'warn'
							: 'neutral',
		}),
	);
</script>

{#snippet absent(text: string)}
	<span class="line-record__absent" data-slot="absent-value"
		><span class="line-record__hollow" aria-hidden="true"></span>{text}</span
	>
{/snippet}

{#snippet dailySummaryLine()}
	<p class="line-record__summary">{dailySummary}</p>
{/snippet}

<div class="line-record-host">
	<section
		class="line-record"
		data-section="verdict"
		data-slot="line-record"
		aria-label={copy.sections.verdict.label}
	>
		<div class="line-record__answer" data-slot="record-answer">
			{#if periodText}
				<p class="line-record__period" data-slot="record-period">{periodText}</p>
			{/if}
			{#if answer.kind === 'figure'}
				<p class="line-record__line">
					<span class="line-record__figure" data-slot="record-figure">{pct(answer.percent)}</span
					>{t.answerAfter}
				</p>
				<p class="line-record__def">{t.band}</p>
				<p
					class="line-record__def"
					data-slot="record-classification"
					data-classification={answer.classification}
				>
					{t.classification[answer.classification]}
				</p>
			{:else}
				<p class="line-record__line line-record__line--absent">{@render absent(t.absent)}</p>
			{/if}
		</div>

		<div class="line-record__evidence" data-slot="record-evidence">
			{#if answer.kind === 'figure'}
				<p data-slot="record-readings">
					{#if answer.readings == null}
						{t.readingsAbsent}
					{:else}
						<span class="line-record__lead"
							>{t.readings(count(answer.readings), answer.readings)}</span
						>
						{t.readingsNote}
					{/if}
				</p>
				{#if period}
					<p data-slot="record-comparison">{t.comparison(period.days, count(period.days))}</p>
				{/if}
				<p data-slot="record-interval">
					{#if answer.interval}
						<span class="line-record__lead"
							>{t.interval(pct(answer.interval.lo)!, pct(answer.interval.hi)!)}</span
						>
						{t.intervalNote}
					{:else}
						{t.intervalAbsent}
					{/if}
				</p>
			{/if}
			<div class="line-record__actions" data-slot="record-actions">
				<RecordCopyButton
					label={terms.action.copyLink}
					done={t.linkCopied}
					fallbackLabel={t.copyFallback}
					text={href}
				/>
				{#if citationText}
					<RecordCopyButton
						label={terms.action.citeRecord}
						done={t.citeCopied}
						fallbackLabel={t.copyFallback}
						text={citationText}
					/>
				{/if}
			</div>
		</div>

		<section class="line-record__daily" data-slot="record-daily" aria-label={t.daily.title}>
			<CollapsibleSection
				title={t.daily.title}
				summary={dailySummaryLine}
				headerVariant="article-summary"
				anchor="rel-daily"
			>
				<div class="line-record__body">
					{#if daily.rows.length > 0}
						<DailyOnTimeChart {daily} {locale} {copy} />
					{/if}

					<dl class="line-record__delays" data-slot="record-delays">
						{#each delays as row (row.key)}
							<div data-metric={row.key}>
								<dt>{row.label}</dt>
								<dd>
									{#if row.value}{row.value}{:else}{@render absent(t.delays.notPublished)}{/if}
								</dd>
							</div>
						{/each}
					</dl>

					<Detail label={copy.sections.detailShow} labelOpen={copy.sections.detailHide}>
						<div class="block" data-slot="delay-distribution" data-card>
							<div class="block-head">
								<span class="label-with-info">
									<SectionLabel text={copy.strip.delayDistHeading} variant="metric" />
									<MetricInfo
										class="cluster-info"
										metricKey="p50p90"
										{locale}
										name={copy.strip.delayDistHeading}
										side="bottom"
									/>
								</span>
							</div>
							{#if distSpec.kind === 'histogram'}
								<Chart spec={distSpec} />
								<p class="caption" data-slot="delay-dist-caption">{copy.strip.delayDistCaption}</p>
							{:else}
								<p class="caption">
									{#if estimatedPercentiles}<span data-slot="absent-value"
											>{copy.strip.notPublished}</span
										>{:else}<AbsentValue reason={distSpec.reason} variant="row" {locale} />{/if}
								</p>
							{/if}
							{#if dailyPercentiles != null}
								<p class="caption" data-slot="daily-percentile-spread">
									{dailyPercentileCaption(dailyPercentiles, locale)}
								</p>
							{/if}
							{#if mode === 'day' && !estimatedPercentiles && !hasDist}
								<p class="caption" data-slot="percentile-nudge">{copy.strip.percentileNudge}</p>
							{/if}
						</div>

						<div class="block" data-slot="severe-share" data-card>
							<div class="block-head">
								<span class="label-with-info">
									<SectionLabel text={copy.strip.severePct} variant="metric" />
									<MetricInfo
										class="cluster-info"
										metricKey="severe"
										{locale}
										name={copy.strip.severePct}
										side="bottom"
									/>
								</span>
								<span class="block-value" class:block-value--empty={severePct == null}>
									<MaybeValue value={fmtPct(severePct)} reason="no-observations" {locale} />
								</span>
							</div>
							<Chart spec={severeBullet} />
							<p class="caption" data-slot="severe-caption">{copy.strip.severeCaption}</p>
						</div>
					</Detail>
				</div>
			</CollapsibleSection>
		</section>
	</section>
</div>

<style>
	.line-record-host {
		container: line-record / inline-size;
		width: 100%;
	}
	.line-record {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		grid-template-areas: 'answer' 'evidence' 'daily';
		gap: 1.25rem;
	}
	.line-record__answer {
		grid-area: answer;
		display: grid;
		align-content: start;
		gap: 0.5rem;
		min-width: 0;
	}
	.line-record__evidence {
		grid-area: evidence;
		display: grid;
		align-content: start;
		gap: 0.75rem;
		min-width: 0;
		color: var(--muted-foreground);
		font-size: var(--text-small);
		line-height: 1.5;
	}
	.line-record__daily {
		grid-area: daily;
		min-width: 0;
	}
	@container line-record (min-width: 46rem) {
		.line-record {
			grid-template-columns: minmax(0, 8fr) minmax(0, 4fr);
			grid-template-areas: 'answer evidence' 'daily evidence';
			column-gap: 2rem;
			row-gap: 1.5rem;
		}
		.line-record__evidence {
			grid-row: 1 / span 2;
			padding-inline-start: 1.5rem;
			border-inline-start: 1px solid var(--border-subtle);
		}
	}
	.line-record p {
		margin: 0;
	}
	.line-record__period {
		color: var(--foreground);
		font-size: var(--text-small);
		font-weight: 500;
	}
	.line-record__line {
		color: var(--foreground);
		font-size: var(--text-subheading);
		line-height: 1.3;
		text-wrap: pretty;
	}
	.line-record__figure {
		margin-inline-end: 0.08em;
		font-family: var(--font-heading);
		font-size: var(--text-display);
		font-weight: 600;
		letter-spacing: var(--tracking-tight);
		line-height: 1;
		font-variant-numeric: tabular-nums;
	}
	.line-record__def {
		color: var(--muted-foreground);
		font-size: var(--text-small);
	}
	.line-record__lead {
		color: var(--foreground);
	}
	.line-record__actions {
		display: flex;
		flex-wrap: wrap;
		align-items: start;
		gap: 0.5rem 0.75rem;
		padding-top: 0.25rem;
	}
	.line-record__absent {
		display: inline-flex;
		align-items: baseline;
		gap: 0.5rem;
		color: var(--muted-foreground);
	}
	.line-record__hollow {
		flex: none;
		width: 0.625rem;
		height: 0.625rem;
		border: 2px solid currentColor;
		border-radius: 50%;
	}
	.line-record__summary {
		color: var(--muted-foreground);
		font-size: var(--text-small);
	}
	.line-record__body {
		display: grid;
		gap: 1rem;
		min-width: 0;
	}
	.line-record__delays {
		display: grid;
		gap: 0.25rem;
		margin: 0;
		font-size: var(--text-small);
	}
	.line-record__delays > div {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 0.25rem 1rem;
		padding-block: 0.375rem;
		border-bottom: 1px solid var(--border-subtle);
	}
	.line-record__delays dt {
		color: var(--muted-foreground);
	}
	.line-record__delays dd {
		margin: 0;
		color: var(--foreground);
		font-variant-numeric: tabular-nums;
	}
	.block {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
	}
	.block-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.5rem;
	}
	.label-with-info {
		min-width: 0;
	}
	.caption {
		margin: 0;
		font-family: var(--font-mono);
		font-size: var(--text-small);
		line-height: 1.4;
		color: var(--muted-foreground);
	}
	.block-value {
		font-family: var(--font-mono);
		font-size: var(--text-small);
		color: var(--foreground);
		font-variant-numeric: tabular-nums;
	}
	.block-value--empty {
		color: var(--muted-foreground);
	}
</style>
