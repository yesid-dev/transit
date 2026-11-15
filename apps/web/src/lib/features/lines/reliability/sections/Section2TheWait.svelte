<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import { intl } from '#lib/i18n/copy.ts';
	import { absenceShort } from '#lib/site/absence.ts';
	import { fmtCount, fmtDelayMin } from '#lib/utils/index.ts';
	import type { HeadwayPeriod, ServiceSpanPeriod } from '#lib/v1/index.ts';
	import { Chart } from '#lib/components/dataviz/chart/index.ts';
	import { selectServiceSpan } from '../selectors/serviceSpan';
	import MetricDisplay from '#lib/components/brand/MetricDisplay.svelte';
	import { SectionLabel } from '@yesid/ui/brand';
	import CollapsibleSection from './CollapsibleSection.svelte';
	import Detail from '#lib/components/shared/Detail.svelte';
	import MetricInfo from '#lib/features/metrics/MetricInfo.svelte';
	import type { WaitRegularityVM } from '../clusters';
	import type { CutScope } from '../selectors/evidence';
	import { scopeDates } from '../recordDates';
	import type { ReliabilityCopy } from '../reliability.copy';

	interface Section2TheWaitProps {
		wait: WaitRegularityVM;
		serviceSpans?: ServiceSpanPeriod[];
		/** Which days the published gap cut covers. */
		scope: CutScope;
		locale: Locale;
		copy: ReliabilityCopy;
	}

	let { wait, serviceSpans = [], scope, locale, copy }: Section2TheWaitProps = $props();

	const e = $derived(copy.evidence);
	const t = $derived(copy.evidence.gaps);
	const spanCopy = $derived(copy.serviceSpanTimeline);
	const valueNoData = $derived(absenceShort('no-observations', locale));
	const min = (v: number | null | undefined): string | null =>
		fmtDelayMin(v, { rounding: 'fixed1' });
	const count = (v: number | null | undefined): string | null => fmtCount(v);
	const periodName = (key: string) => (e.timeOfDay.periods as Record<string, string>)[key] ?? key;

	// The all-period gaps lead; direction or day-type splits only stand in when nothing else is published.
	const isPrimary = (h: HeadwayPeriod) =>
		h.direction_id == null && h.day_type == null && !/_dir\d|_weekend/.test(h.shift);
	const primary = $derived(wait.headway.filter(isPrimary));
	const rows = $derived(primary.length > 0 ? primary : wait.headway);
	const label = (h: HeadwayPeriod) => {
		const base = periodName(h.shift.replace(/_dir\d/, '').replace(/_weekend/, ''));
		const dir = h.direction_id ?? h.shift.match(/_dir(\d)/)?.[1];
		const extras = [
			dir != null ? `dir ${dir}` : null,
			h.day_type === 'weekend' || h.shift.includes('_weekend') ? e.timeOfDay.periods.weekend : null,
		].filter(Boolean);
		return extras.length > 0 ? `${base} · ${extras.join(' · ')}` : base;
	};

	const shown = $derived(
		scope.kind !== 'none' &&
			rows.some((h) => gapMinutes(h.scheduled_min) ?? gapMinutes(h.observed_min)),
	);
	const dates = $derived(scopeDates(scope, locale, e.history));
	// Median gaps in minutes, as published: a gap between trips is a positive duration; 0 or less is withheld.
	const gapMinutes = (v: number | null | undefined): string | null =>
		typeof v === 'number' && Number.isFinite(v) && v > 0
			? intl.number(locale, { maximumFractionDigits: 1 }).format(Math.round(v * 10) / 10 + 0)
			: null;

	const latestSpan = $derived<ServiceSpanPeriod | null>(
		serviceSpans.length > 0 ? serviceSpans[serviceSpans.length - 1] : null,
	);
	const spanDuration = (v: number | null | undefined): string | null => {
		if (v == null || Number.isNaN(v)) return null;
		const total = Math.max(0, Math.round(v));
		const h = Math.floor(total / 60);
		const m = total % 60;
		return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
	};
	const serviceSpanSpec = $derived(
		latestSpan
			? selectServiceSpan(
					{
						firstTripUtc: latestSpan.first_trip_utc ?? null,
						lastTripUtc: latestSpan.last_trip_utc ?? null,
						firstDelayMin: latestSpan.first_trip_delay_min ?? null,
						lastDelayMin: latestSpan.last_trip_delay_min ?? null,
					},
					locale,
					{
						firstLabel: spanCopy.firstTrip,
						lastLabel: spanCopy.lastTrip,
						firstDelayLabel: spanCopy.firstDelay,
						lastDelayLabel: spanCopy.lastDelay,
						spanLabel:
							spanDuration(latestSpan.service_span_min) != null
								? spanCopy.span(spanDuration(latestSpan.service_span_min)!)
								: null,
						tripsLabel:
							count(latestSpan.trip_count) != null
								? spanCopy.trips(count(latestSpan.trip_count)!)
								: null,
						hourLabel: (h) => `+${h}h`,
						ariaLabel: spanCopy.ariaLabel,
						absentTitle: spanCopy.heading,
						noDataLabel: valueNoData,
					},
				)
			: null,
	);
	const spanMetrics = $derived(
		latestSpan
			? [
					{ label: spanCopy.spanMetric, value: min(latestSpan.service_span_min) },
					{ label: spanCopy.firstDelay, value: min(latestSpan.first_trip_delay_min) },
					{ label: spanCopy.lastDelay, value: min(latestSpan.last_trip_delay_min) },
					{ label: spanCopy.tripCount, value: count(latestSpan.trip_count) },
				]
			: [],
	);
</script>

<CollapsibleSection dataSection="the-wait" title={copy.sections.theWait.label} summary={t.summary}>
	<div class="evidence-body">
		{#if shown}
			<div class="gaps">
				<table class="evidence-table" data-slot="gaps-table">
					<caption
						>{t.caption}
						{#if dates}{e.scope(dates)}{/if}</caption
					>
					<thead>
						<tr>
							<th scope="col">{e.timeOfDay.columns.period}</th>
							<th scope="col" class="n">{t.scheduled}</th>
							<th scope="col" class="n">{t.firstReports}</th>
						</tr>
					</thead>
					<tbody>
						{#each rows as h, index (`${h.shift}-${index}`)}
							<tr>
								<th scope="row">{label(h)}</th>
								{#each [h.scheduled_min, h.observed_min] as value, column (column)}
									<td class="n">
										{#if gapMinutes(value) != null}{gapMinutes(value)}{:else}<span
												class="evidence-absent"
												data-slot="absent-value">{e.notPublished}</span
											>{/if}
									</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
				<p class="evidence-note" data-slot="gaps-definition">{t.definition}</p>
			</div>
		{:else}
			<p data-slot="the-wait-empty">
				<span class="evidence-absent" data-slot="absent-value"
					>{scope.kind === 'none' && scope.range ? t.absentRange : e.notPublished}</span
				>
			</p>
		{/if}

		<div class="frequent" data-slot="frequency-unpublished">
			<p class="frequent__title">{t.frequentTitle}</p>
			<p class="evidence-note">{t.frequent}</p>
		</div>

		{#if latestSpan}
			<Detail label={copy.sections.detailShow} labelOpen={copy.sections.detailHide}>
				<div class="span" data-sub="service-span" data-card>
					<div class="span-head">
						<span class="label-with-info">
							<SectionLabel text={spanCopy.heading} variant="metric" />
							<MetricInfo
								class="cluster-info"
								metricKey="serviceSpan"
								{locale}
								name={spanCopy.heading}
								side="bottom"
							/>
						</span>
						<span class="span-window" data-slot="service-span-window">
							{copy.windows.serviceSpan(latestSpan.date ?? null)}
						</span>
					</div>
					{#if serviceSpanSpec}
						<Chart spec={serviceSpanSpec} />
					{/if}
					<p class="span-caption" data-slot="service-span-caption">{spanCopy.caption}</p>
					<div class="span-metrics">
						{#each spanMetrics as metric (metric.label)}
							<MetricDisplay
								value={metric.value}
								absentReason="no-observations"
								{locale}
								label={metric.label}
								size="sm"
							/>
						{/each}
					</div>
				</div>
			</Detail>
		{/if}
	</div>
</CollapsibleSection>

<style>
	.gaps,
	.span {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-width: 0;
	}
	.frequent {
		display: grid;
		gap: 0.25rem;
		padding-inline-start: 0.75rem;
		border-inline-start: 2px solid var(--border-strong);
	}
	.frequent__title {
		margin: 0;
		font-weight: 600;
	}
	.span-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.25rem 1rem;
	}
	.span-window,
	.span-caption {
		margin: 0;
		font-family: var(--font-mono);
		font-size: var(--text-small);
		line-height: 1.4;
		color: var(--muted-foreground);
	}
	.span-metrics {
		display: grid;
		gap: var(--space-card-gap);
		grid-template-columns: repeat(auto-fit, minmax(min(11rem, 100%), 1fr));
	}
</style>
