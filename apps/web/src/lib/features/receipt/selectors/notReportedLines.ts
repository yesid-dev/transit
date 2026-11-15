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

export interface NoLiveDataLine {
	readonly key: string;
	readonly title: string;
	readonly href: string;
}

export interface NotReportedVM {
	/** Lines that publish live data but never appeared in it. */
	readonly rows: NotReportedRow[];
	readonly shown: number;
	/** All not-reported lines minus the listed lines that publish no live data. */
	readonly total: number | null;
	/** Listed lines that publish no live data, so they could never appear live. */
	readonly noLiveData: readonly NoLiveDataLine[];
	readonly hasData: boolean;
}

export interface NotReportedLabels {
	readonly directory: LineDirectory;
	readonly rowLabel: string;
	readonly href: (id: string) => string;
	readonly fmtScheduled: (v: number | null | undefined) => string | null;
	readonly hasNoLiveData: (id: string) => boolean;
}

export function selectNotReportedLines(
	states: Partial<NonNullable<ReceiptReliabilityView['serviceStates']>> | null | undefined,
	labels: NotReportedLabels,
): NotReportedVM {
	const listed = states?.notReportedRoutes ?? [];
	const list = listed.filter((r) => !labels.hasNoLiveData(r.id));
	const noLiveData = listed
		.filter((r) => labels.hasNoLiveData(r.id))
		.map((r) => ({
			key: r.id,
			title: labels.directory.name(r.id, r.name).label,
			href: labels.href(r.id),
		}));
	const count = states?.notReportedRouteCount ?? null;
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
		total: count == null ? null : Math.max(count - noLiveData.length, 0),
		noLiveData,
		hasData: listed.length > 0,
	};
}
