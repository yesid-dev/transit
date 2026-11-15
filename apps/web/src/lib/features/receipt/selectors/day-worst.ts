import type { LineDirectory } from '#lib/site/lineDirectory.ts';
import type { ReceiptReliabilityView } from '#lib/v1/reliabilityView.ts';

export interface WorstRowVM {
	readonly id: string;
	readonly title: string;
	readonly subtitle: string;
	readonly meta: string;
}

export interface WorstOfDayVM {
	readonly route: WorstRowVM | null;
	readonly stop: WorstRowVM | null;
	readonly hasWorst: boolean;
}

export interface WorstOfDayLabels {
	readonly directory: LineDirectory;
	readonly stopName: (id: string, fallbackName: string | null | undefined) => string;
	readonly routeLabel: string;
	readonly stopLabel: string;
	readonly routeDeltaLabel: string;
	readonly stopDelayLabel: string;
	readonly fmtDelta: (v: number | null | undefined) => string;
	readonly fmtMin: (v: number | null | undefined) => string;
}

export function selectWorstOfDay(
	receipt: Pick<ReceiptReliabilityView, 'worstRoute' | 'worstStop'>,
	labels: WorstOfDayLabels,
): WorstOfDayVM {
	const wr = receipt.worstRoute;
	const ws = receipt.worstStop;
	const route: WorstRowVM | null = wr?.id
		? {
				id: wr.id,
				title: labels.directory.name(wr.id, wr.name).label,
				subtitle: labels.routeLabel,
				meta: `${labels.routeDeltaLabel} ${labels.fmtDelta(wr.onTimeDeltaPts)}`,
			}
		: null;
	const stop: WorstRowVM | null = ws?.id
		? {
				id: ws.id,
				title: labels.stopName(ws.id, ws.name),
				subtitle: `${labels.stopLabel} · ${ws.id}`,
				meta: `${labels.stopDelayLabel} ${labels.fmtMin(ws.meanDelayMin)}`,
			}
		: null;
	return { route, stop, hasWorst: route != null || stop != null };
}
