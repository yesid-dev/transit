import type { ReceiptReliabilityView } from '#lib/v1/reliabilityView.ts';

export interface AffectedCountVM {
	readonly key: 'routes' | 'stops' | 'alerts' | 'vehicles';
	readonly label: string;
	readonly value: string | null;
}

export interface AffectedCountLabels {
	readonly routes: string;
	readonly stops: string;
	readonly alerts: string;
	readonly vehicles: string;
	readonly fmtCount: (v: number | null | undefined) => string | null;
}

export function selectAffectedCounts(
	receipt: Pick<ReceiptReliabilityView, 'affectedRoutes' | 'affectedStops' | 'alerts' | 'vehicles'>,
	labels: AffectedCountLabels,
): AffectedCountVM[] {
	const cells: AffectedCountVM[] = [
		{ key: 'routes', label: labels.routes, value: labels.fmtCount(receipt.affectedRoutes) },
		{ key: 'stops', label: labels.stops, value: labels.fmtCount(receipt.affectedStops) },
		{ key: 'alerts', label: labels.alerts, value: labels.fmtCount(receipt.alerts) },
	];
	if (receipt.vehicles != null) {
		cells.push({
			key: 'vehicles',
			label: labels.vehicles,
			value: labels.fmtCount(receipt.vehicles),
		});
	}
	return cells;
}
