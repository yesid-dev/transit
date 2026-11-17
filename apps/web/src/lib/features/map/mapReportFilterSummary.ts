import type { Locale } from '#lib/i18n/index.ts';
import type { FilterState } from '#lib/filters/index.ts';
import { OCCUPANCY_LABELS } from '#lib/v1/enumLabels.ts';
import { copy as mapCopy } from './map.copy';
import { mapStatusLabel } from './mapStatusLabels';

export interface MapReportFilterNames {
	/** The line number as the site shows it, from the shared line directory. */
	readonly line: (id: string) => string;
	/** The stop's displayed name from the shared stop index, falling back to its ID. */
	readonly stop: (id: string) => string;
}

/**
 * The active live filters, named for readers, in the same order the report model tokenizes them.
 * Values arrive from the existing filter store; nothing here narrows or reinterprets them.
 */
export function mapReportFilterLabels(
	filter: FilterState,
	locale: Locale,
	names: MapReportFilterNames,
): string[] {
	const t = mapCopy[locale];
	const labels: string[] = [];
	if (filter.showOutOfService) labels.push(t.outOfServiceVehicles);
	for (const id of [...filter.routes].sort()) labels.push(names.line(id));
	for (const id of [...filter.stops].sort()) labels.push(names.stop(id));
	for (const id of [...filter.trips].sort()) labels.push(`${t.tripLabel} ${id}`);
	for (const id of [...filter.vehicles].sort()) labels.push(`${t.vehicleLabel} ${id}`);
	for (const code of filter.status ?? []) labels.push(mapStatusLabel(locale, code));
	for (const code of filter.occupancy ?? []) labels.push(OCCUPANCY_LABELS[locale][code]);
	for (const kind of filter.entities ?? []) {
		labels.push(kind === 'stop' ? t.entityStop : t.entityBus);
	}
	for (const _kind of filter.alerts ?? []) labels.push(t.alertHas);
	return labels;
}
