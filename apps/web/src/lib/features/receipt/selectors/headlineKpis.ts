import type { ReceiptReliabilityView } from '#lib/v1/reliabilityView.ts';
import type { MetricKey } from '#lib/features/metrics/metrics.content.ts';

export interface HeadlineKpiVM {
	readonly key: MetricKey;
	readonly label: string;
	readonly value: string | null;
	readonly size: 'sm' | 'md' | 'lg';
}

export interface HeadlineKpiLabels {
	readonly onTime: string;
	readonly avgDelay: string;
	readonly severe: string;
	readonly fmtPct: (v: number | null | undefined) => string | null;
	readonly fmtMin: (v: number | null | undefined) => string | null;
	readonly fmtSeverePct: (v: number | null | undefined) => string | null;
}

export function selectHeadlineKpis(
	receipt: Pick<ReceiptReliabilityView, 'onTimePct' | 'meanDelayMin' | 'severePct'>,
	labels: HeadlineKpiLabels,
): HeadlineKpiVM[] {
	return [
		{ key: 'otp', label: labels.onTime, value: labels.fmtPct(receipt.onTimePct), size: 'lg' },
		{
			key: 'avgDelay',
			label: labels.avgDelay,
			value: labels.fmtMin(receipt.meanDelayMin),
			size: 'lg',
		},
		{
			key: 'severe',
			label: labels.severe,
			value: labels.fmtSeverePct(receipt.severePct),
			size: 'md',
		},
	];
}
