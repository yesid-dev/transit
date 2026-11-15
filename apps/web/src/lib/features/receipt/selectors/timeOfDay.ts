import {
	SHIFT_GRAIN_ORDER,
	severeShareToSeverity,
	SEVERE_DOMAIN,
} from '#lib/features/reliability/shiftGrains.ts';
import type { SeverityCode } from '#lib/v1/schemas/index.ts';
import type { ReceiptReliabilityView } from '#lib/v1/reliabilityView.ts';

export interface ReceiptShiftRow {
	readonly key: string;
	readonly rank: number;
	readonly title: string;
	readonly severity: SeverityCode;
	readonly value: number;
	readonly domain: readonly [number, number];
	readonly unit: string;
	readonly display: string;
}

export interface ReceiptTimeOfDayVM {
	readonly rows: ReceiptShiftRow[];
	readonly hasTimeOfDay: boolean;
}

export interface ReceiptTimeOfDayLabels {
	readonly shiftLabel: (shift: string) => string;
}

function shiftRank(shift: string): number {
	const i = SHIFT_GRAIN_ORDER.indexOf(shift as (typeof SHIFT_GRAIN_ORDER)[number]);
	return i === -1 ? SHIFT_GRAIN_ORDER.length : i;
}

export function selectReceiptTimeOfDay(
	byShift: ReceiptReliabilityView['byShift'] | null | undefined,
	labels: ReceiptTimeOfDayLabels,
): ReceiptTimeOfDayVM {
	const real = (byShift ?? []).filter((c) => c.severePct != null);
	const rows: ReceiptShiftRow[] = real
		.slice()
		.sort(
			(a, b) => (b.severePct ?? 0) - (a.severePct ?? 0) || shiftRank(a.shift) - shiftRank(b.shift),
		)
		.map((c, i) => {
			const sev = c.severePct ?? 0;
			return {
				key: c.shift,
				rank: i + 1,
				title: labels.shiftLabel(c.shift),
				severity: severeShareToSeverity(c.severePct ?? null),
				value: sev,
				domain: SEVERE_DOMAIN,
				unit: '%',
				display: `${sev.toFixed(1)}%`,
			};
		});
	return { rows, hasTimeOfDay: rows.length > 0 };
}
