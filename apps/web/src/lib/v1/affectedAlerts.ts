import type { Alert } from './schemas/alerts';
import { SEVERITY_CODES, type SeverityCode } from './schemas/types';

function severityRank(severity: SeverityCode): number {
	const i = (SEVERITY_CODES as readonly string[]).indexOf(severity);
	return i === -1 ? SEVERITY_CODES.length : i;
}

function alertListsRoute(alert: Alert, routeId: string): boolean {
	return (alert.routes ?? []).includes(routeId);
}

export function alertsForRoute(
	alerts: readonly Alert[] | null | undefined,
	routeId: string,
): Alert[] {
	if (!alerts || !routeId) return [];
	return alerts
		.map((alert, order) => ({ alert, order }))
		.filter(({ alert }) => alertListsRoute(alert, routeId))
		.sort(
			(a, b) =>
				severityRank(a.alert.severity) - severityRank(b.alert.severity) || a.order - b.order,
		)
		.map(({ alert }) => alert);
}
