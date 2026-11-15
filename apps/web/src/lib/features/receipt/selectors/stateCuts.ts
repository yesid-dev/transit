import { CANCEL_RATE_DOMAIN } from '#lib/features/reliability/domains.ts';
import type { SeverityCode } from '#lib/v1/schemas/index.ts';
import type { ReceiptReliabilityView } from '#lib/v1/reliabilityView.ts';

export type ServiceStateKind = 'delivered' | 'cancelled' | 'silent';

export interface StateCutRow {
	readonly key: ServiceStateKind;
	readonly label: string;
	readonly severity: SeverityCode;
	readonly value: number | null;
	readonly domain: readonly [number, number];
	readonly display: string | null;
}

export interface StateCutsVM {
	readonly basis: number | null;
	readonly scheduled: number | null;
	readonly beyond: number | null;
	readonly mismatch: boolean;
	readonly completeness: number | null;
	readonly completenessDisplay: string | null;
	readonly rows: StateCutRow[];
	readonly hasData: boolean;
}

export interface StateCutsLabels {
	readonly delivered: string;
	readonly cancelled: string;
	readonly silent: string;
	readonly fmtSharePct: (v: number | null) => string | null;
}

function stateSeverity(kind: ServiceStateKind, share: number | null): SeverityCode {
	if (share == null) return 'watch';
	if (kind === 'delivered') return 'watch';
	if (share >= 10) return 'critical';
	if (share >= 5) return 'high';
	return 'watch';
}

function share(
	count: number | null | undefined,
	scheduled: number | null | undefined,
): number | null {
	if (count == null || scheduled == null || scheduled <= 0) return null;
	return (count / scheduled) * 100;
}

export function selectStateCuts(
	states: Partial<NonNullable<ReceiptReliabilityView['serviceStates']>> | null | undefined,
	labels: StateCutsLabels,
): StateCutsVM {
	const scheduled = states?.scheduledTripDays ?? null;
	const beyond = states?.beyondScheduleTripDays ?? null;
	const counts = [states?.deliveredTripDays, states?.cancelledTripDays, states?.silentTripDays];
	const known = scheduled != null && counts.every((n) => n != null);
	const basis = scheduled == null ? null : scheduled + (beyond ?? 0);
	const valid =
		known &&
		[scheduled, beyond ?? 0, ...counts].every((n) => Number.isSafeInteger(n) && n! >= 0) &&
		Number.isSafeInteger(basis) &&
		counts.reduce<number>((sum, n) => sum + n!, 0) === basis;
	const mismatch = known && !valid;
	const denominator = valid ? basis : null;
	const deliveredShare = share(states?.deliveredTripDays, denominator);
	const cancelledShare = share(states?.cancelledTripDays, denominator);
	const silentShare = share(states?.silentTripDays, denominator);

	const rows: StateCutRow[] = (
		[
			['delivered', labels.delivered, deliveredShare],
			['cancelled', labels.cancelled, cancelledShare],
			['silent', labels.silent, silentShare],
		] as const
	).map(([key, label, value]) => ({
		key,
		label,
		severity: stateSeverity(key, value),
		value,
		domain: CANCEL_RATE_DOMAIN,
		display: labels.fmtSharePct(value),
	}));

	const completeness = deliveredShare;
	const hasData = mismatch || rows.some((r) => r.value != null);

	return {
		basis: valid ? basis : null,
		scheduled,
		beyond,
		mismatch,
		completeness,
		completenessDisplay: labels.fmtSharePct(completeness),
		rows,
		hasData,
	};
}
