import type { LineDirectory } from '#lib/site/lineDirectory.ts';
import type { SeverityCode } from '#lib/v1/schemas/index.ts';
import type { ReceiptReliabilityView } from '#lib/v1/reliabilityView.ts';

export const NOT_REPORTED_DOMAIN: readonly [number, number] = [0, 20];

export interface NotReportedRow {
	readonly key: string;
	readonly rank: number;
	readonly title: string;
	readonly subtitle: string;
	readonly severity: SeverityCode;
	readonly value: number | null;
	readonly domain: readonly [number, number];
	readonly display: string | null;
	readonly href: string;
	readonly ariaLabel?: string;
}

export interface NotReportedVM {
	readonly rows: NotReportedRow[];
	readonly shown: number;
	readonly total: number | null;
	readonly hasData: boolean;
}

export interface NotReportedLabels {
	readonly directory: LineDirectory;
	readonly rowLabel: string;
	readonly href: (id: string) => string;
	readonly fmtScheduled: (v: number | null | undefined) => string | null;
}

export function selectNotReportedLines(
	states: Partial<NonNullable<ReceiptReliabilityView['serviceStates']>> | null | undefined,
	labels: NotReportedLabels,
): NotReportedVM {
	const list = states?.notReportedRoutes ?? [];
	const rows: NotReportedRow[] = list.map((r, i) => ({
		key: r.id,
		rank: i + 1,
		title: labels.directory.name(r.id, r.name).label,
		subtitle: labels.rowLabel,
		severity: 'critical' as SeverityCode,
		value: r.scheduledTripDays ?? null,
		domain: NOT_REPORTED_DOMAIN,
		display: labels.fmtScheduled(r.scheduledTripDays),
		href: labels.href(r.id),
	}));
	return {
		rows,
		shown: rows.length,
		total: states?.notReportedRouteCount ?? null,
		hasData: rows.length > 0,
	};
}
