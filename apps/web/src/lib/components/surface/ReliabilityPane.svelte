<script lang="ts">
	import { cn, fmtDelayMin } from '#lib/utils/index.ts';
	import { fmtLocalePct } from '#lib/utils/format.ts';
	import type { Locale } from '#lib/i18n/index.ts';
	import type { Snippet } from 'svelte';
	import { SectionLabel } from '@yesid/ui/brand';
	import MetricDisplay from '#lib/components/brand/MetricDisplay.svelte';
	import { SeverityBar } from '#lib/components/dataviz/index.ts';
	import { Chart, type SparklineSpec } from '#lib/components/dataviz/chart/index.ts';
	import { sparkZoomDomain } from '#lib/components/dataviz/chart/sparkDomain.ts';

	export interface ReliabilityPeriodVM {
		grain: string;
		/** Share of readings more than five minutes late: the record answer's own measure. */
		latePct: number | null;
		delayMin: number | null;
		delayKind?: 'avg' | 'median';
		p90Min?: number | null;
	}

	export interface ReliabilityPaneProps {
		periods: readonly ReliabilityPeriodVM[];
		locale: Locale;
		delayLabelKind?: 'avg' | 'median';
		metricInfo?: Snippet<[key: 'avgDelay' | 'p50p90' | 'severe', label: string]>;
		class?: string;
	}

	let {
		periods,
		locale,
		delayLabelKind = 'avg',
		metricInfo,
		class: className,
	}: ReliabilityPaneProps = $props();

	type Labels = {
		readonly late: string;
		readonly delayAvg: string;
		readonly delayMedian: string;
		readonly p90: string;
		readonly p90Caption: string;
		readonly trend: string;
		readonly unitPct: string;
	};
	const L: Record<Locale, Labels> = {
		fr: {
			late: 'Plus de 5 min de retard',
			delayAvg: 'Retard moyen',
			delayMedian: 'Retard médian',
			p90: 'p90',
			p90Caption: '90e percentile des relevés de retard',
			trend: 'Part des prévisions à plus de 5 minutes de retard',
			unitPct: '%',
		},
		en: {
			late: 'More than 5 min late',
			delayAvg: 'Avg delay',
			delayMedian: 'Median delay',
			p90: 'p90',
			p90Caption: '90th percentile of reported delays',
			trend: 'Share of predictions more than 5 minutes late',
			unitPct: '%',
		},
	};
	const t = $derived(L[locale]);

	const min = (v: number | null | undefined): string | null =>
		fmtDelayMin(v, { locale, rounding: 'fixed1' });

	const lateSeries = $derived(periods.map((p) => p.latePct));

	const sparkSpec = $derived.by<SparklineSpec | null>(() => {
		const domain = sparkZoomDomain(lateSeries, { clampHi: 100 });
		if (domain == null) return null;
		return {
			kind: 'sparkline',
			title: t.trend,
			locale,
			domain,
			unit: t.unitPct,
			label: t.late,
			values: lateSeries,
			xLabels: periods.map((p) => p.grain),
			showLast: true,
			width: 160,
			height: 32,
		};
	});
</script>

{#if periods.length > 0}
	<div class={cn('reliability-pane', className)} data-slot="reliability-pane">
		<div class="reliability-cards">
			{#each periods as period (period.grain)}
				{@const median = (period.delayKind ?? delayLabelKind) === 'median'}
				{@const delayLabel = median ? t.delayMedian : t.delayAvg}
				<div class="reliability-card">
					<SectionLabel text={period.grain} variant="metric" />
					<div class="reliability-metrics">
						{#if period.latePct != null}
							<div class="reliability-late">
								<MetricDisplay
									value={fmtLocalePct(period.latePct, locale)}
									label={t.late}
									size="sm"
								>
									{#snippet info()}{@render metricInfo?.('severe', t.late)}{/snippet}
								</MetricDisplay>
								<!-- The figure above says it; the bar only draws it, so it takes no focus. -->
								<SeverityBar
									severity="watch"
									value={period.latePct / 100}
									{locale}
									aria-hidden="true"
								/>
							</div>
						{/if}
						<MetricDisplay
							value={min(period.delayMin)}
							absentReason="no-observations"
							{locale}
							label={delayLabel}
							size="sm"
						>
							{#snippet info()}{@render metricInfo?.(
									median ? 'p50p90' : 'avgDelay',
									delayLabel,
								)}{/snippet}
						</MetricDisplay>
						{#if period.p90Min != null}
							<MetricDisplay
								value={min(period.p90Min)}
								label={t.p90}
								sublabel={t.p90Caption}
								size="sm"
							>
								{#snippet info()}{@render metricInfo?.('p50p90', t.p90)}{/snippet}
							</MetricDisplay>
						{/if}
					</div>
				</div>
			{/each}
		</div>

		{#if sparkSpec}
			<div class="reliability-trend">
				<SectionLabel text={t.trend} variant="metric" />
				<Chart spec={sparkSpec} />
			</div>
		{/if}
	</div>
{/if}

<style>
	.reliability-pane {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}
	.reliability-cards {
		display: grid;
		gap: 1rem;
		grid-template-columns: 1fr;
	}
	@media (min-width: 640px) {
		.reliability-cards {
			grid-template-columns: repeat(auto-fit, minmax(min(14rem, 100%), 1fr));
		}
	}
	.reliability-card {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1rem 1.25rem;
		background-color: var(--card);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
	}
	.reliability-metrics {
		display: flex;
		flex-wrap: wrap;
		gap: 1.25rem;
	}
	.reliability-late {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		min-inline-size: min(9rem, 100%);
	}
	.reliability-trend {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}
</style>
