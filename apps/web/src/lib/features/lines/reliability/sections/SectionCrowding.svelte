<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import { absenceShort } from '#lib/site/absence.ts';
	import { fmtDelayMin } from '#lib/utils/index.ts';
	import { fmtLocalePct } from '#lib/utils/format.ts';
	import { SectionLabel } from '@yesid/ui/brand';
	import CollapsibleSection from './CollapsibleSection.svelte';
	import { AbsentValue } from '#lib/components/edge/index.ts';
	import { ChartLegend } from '#lib/components/dataviz/index.ts';
	import { occupancyVar } from '#lib/components/dataviz/tokens.ts';
	import { Chart } from '#lib/components/dataviz/chart/index.ts';
	import Detail from '#lib/components/shared/Detail.svelte';
	import { SHARE_DOMAIN, weekdayLabel } from '#lib/features/reliability/shiftGrains.ts';
	import { OCCUPANCY_CODES, type OccupancyCode } from '#lib/v1/schemas/types.ts';
	import { selectCrowdingDelay } from '../selectors/crowdingDelay';
	import { selectBullet } from '../selectors/bullet';
	import { selectOccupancyShare } from '../selectors/occupancyShare';
	import { detailCopy } from '../../lines.copy';
	import type { CrowdingVM } from '../clusters';
	import type { CrowdingFigure } from '../selectors/evidence';
	import type { ReliabilityCopy } from '../reliability.copy';
	import MetricBullet from './MetricBullet.svelte';

	interface SectionCrowdingProps {
		crowding: CrowdingVM;
		/** The mix shown and the days it covers, chosen together (`crowdingFigure`). */
		figure: CrowdingFigure;
		locale: Locale;
		copy: ReliabilityCopy;
	}
	let { crowding, figure, locale, copy }: SectionCrowdingProps = $props();

	const e = $derived(copy.evidence);
	const t = $derived(copy.evidence.crowding);
	const bands = $derived(detailCopy[locale].occupancyBands);
	const noDataLabel = $derived(absenceShort('no-observations', locale));
	const bandLabel = (code: OccupancyCode): string => bands[code];

	const activeMix = $derived(figure.mix);
	const scope = $derived(figure.scope);
	const total = $derived(
		activeMix
			? OCCUPANCY_CODES.reduce((s, c) => s + ((activeMix[c] ?? 0) > 0 ? activeMix[c]! : 0), 0)
			: 0,
	);
	const dominant = $derived.by(() => {
		if (!activeMix || total <= 0) return null;
		let best: { label: string; share: number } | null = null;
		for (const code of OCCUPANCY_CODES) {
			const v = activeMix[code];
			if (v == null || v <= 0) continue;
			if (best == null || v > best.share) best = { label: bands[code], share: v };
		}
		return best;
	});
	const dominantPct = $derived(dominant ? Math.round((dominant.share / total) * 100) : null);
	const summary = $derived(
		dominant && dominantPct != null
			? t.summary(dominant.label, fmtLocalePct(dominantPct, locale)!)
			: t.absent,
	);

	const mixShareSpec = $derived(
		selectOccupancyShare(activeMix, locale, { title: copy.clusters.crowding, label: bandLabel }),
	);
	const mixLegend = $derived(
		(mixShareSpec?.segments ?? []).map((s) => ({
			colorVar: occupancyVar((s.occupancy ?? 'empty') as OccupancyCode),
			label: `${s.label} ${Math.round(s.share)}%`,
			swatch: 'square' as const,
		})),
	);
	const dominantBullet = $derived(
		selectBullet(dominantPct, locale, {
			title: dominant?.label ?? copy.clusters.crowding,
			xLabel: dominant?.label ?? copy.clusters.crowding,
			unit: copy.units.pct,
			domain: SHARE_DOMAIN,
			tone: 'neutral',
		}),
	);
	const crowdingDelay = $derived(
		selectCrowdingDelay(crowding.delayByCrowding, locale, {
			title: copy.delayByCrowding.heading,
			rowLabel: copy.delayByCrowding.bandHeader,
			xLabel: copy.strip.avgDelayMin,
			unit: copy.units.min,
			bandLabel: (code) => bands[code],
			noDataMarker: noDataLabel,
			noteFor: (cell) => {
				const p50 = fmtDelayMin(cell.p50_min, { rounding: 'fixed1' });
				const n = cell.observation_count ?? null;
				return (
					[p50 ? copy.delayByCrowding.typical(p50) : null, n != null ? `n=${n}` : null]
						.filter(Boolean)
						.join(' · ') || undefined
				);
			},
		}),
	);
	const weekdayWeekend = $derived(
		crowding.weekdayWeekend
			? {
					weekday: selectOccupancyShare(crowding.weekdayWeekend.weekday, locale, {
						title: copy.peak.weekday,
						label: bandLabel,
					}),
					weekend: selectOccupancyShare(crowding.weekdayWeekend.weekend, locale, {
						title: copy.peak.weekend,
						label: bandLabel,
					}),
				}
			: null,
	);
	const dayTypeCells = $derived(
		weekdayWeekend
			? [
					{ key: 'weekday', spec: weekdayWeekend.weekday, label: copy.peak.weekday },
					{ key: 'weekend', spec: weekdayWeekend.weekend, label: copy.peak.weekend },
				]
			: [],
	);
	const weekdayStrips = $derived(
		crowding.byWeekday?.map((d) => ({
			iso: d.iso,
			label: weekdayLabel(d.iso, locale),
			spec: selectOccupancyShare(d.mix, locale, {
				title: weekdayLabel(d.iso, locale),
				label: bandLabel,
			}),
		})) ?? null,
	);
</script>

<CollapsibleSection dataSection="crowding" title={copy.sections.crowding.label} {summary}>
	<div class="evidence-body">
		{#if dominant == null}
			<p data-slot="crowding-empty">
				<span class="evidence-absent" data-slot="absent-value">{t.absentBody}</span>
			</p>
		{:else}
			{#if scope}<p class="evidence-lead" data-slot="crowding-window">{e.scope(scope)}</p>{/if}
			<MetricBullet
				label={dominant.label}
				valueText={`${dominantPct}%`}
				spec={dominantBullet}
				{locale}
				size="lg"
				data-slot="dominant-band"
			/>
			{#if mixShareSpec}
				<div class="crowding-bar" data-slot="crowding-mix">
					<Chart spec={mixShareSpec} />
					<ChartLegend items={mixLegend} />
				</div>
			{/if}
			<p class="evidence-note">{t.note}</p>
		{/if}

		<!-- Delay by crowding and the day splits are published apart from the mix; each shows on its own. -->
		{#if dominant != null || crowding.delayByCrowding.length > 0 || weekdayWeekend || weekdayStrips}
			<Detail label={copy.sections.detailShow} labelOpen={copy.sections.detailHide}>
				<div class="block" data-slot="delay-by-crowding" data-card>
					<SectionLabel text={copy.delayByCrowding.heading} variant="metric" />
					<Chart spec={crowdingDelay.spec} />
				</div>
				{#if weekdayWeekend}
					<div class="block" data-slot="crowding-weekday-weekend" data-card>
						<SectionLabel text={copy.peak.dayType} variant="metric" />
						<div class="two-col">
							{#each dayTypeCells as { key, spec, label } (key)}
								<div class="cell" data-slot={`crowding-${key}`}>
									<span class="cell-label">{label}</span>
									{#if spec}<Chart {spec} />{:else}<AbsentValue
											variant="block"
											reason="no-observations"
											{locale}
										/>{/if}
								</div>
							{/each}
						</div>
					</div>
				{/if}
				{#if weekdayStrips}
					<div class="block" data-slot="crowding-by-dow" data-card>
						<SectionLabel text={copy.byDow.heading} variant="metric" />
						<p class="cell-label">{copy.byDow.caption}</p>
						<ul class="dow" aria-label={copy.byDow.heading}>
							{#each weekdayStrips as day (day.iso)}
								<li class="dow-cell" data-slot="crowding-dow-cell" data-iso={day.iso}>
									<span class="cell-label">{day.label}</span>
									{#if day.spec}<Chart spec={day.spec} />{:else}<AbsentValue
											variant="block"
											reason="no-observations"
											{locale}
										/>{/if}
								</li>
							{/each}
						</ul>
					</div>
				{/if}
			</Detail>
		{/if}
	</div>
</CollapsibleSection>

<style>
	.block {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.two-col {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(14rem, 100%), 1fr));
		gap: 1rem 1.5rem;
	}
	.cell {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		min-width: 0;
	}
	.cell-label {
		margin: 0;
		color: var(--muted-foreground);
		font-family: var(--font-mono);
		font-size: var(--text-small);
	}
	.dow {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.dow-cell {
		display: grid;
		grid-template-columns: 6.5rem minmax(0, 1fr);
		align-items: center;
		gap: 0.875rem;
		min-width: 0;
	}
</style>
