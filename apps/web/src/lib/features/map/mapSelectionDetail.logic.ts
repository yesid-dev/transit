import { stopDisplayName as displayStop } from '#lib/site/transitDisplay.ts';
import { absenceShort, stopNameFallback } from '#lib/site/absence.ts';
import { clockTime } from '#lib/site/presenter.ts';
import { localizeHref, type Locale } from '#lib/i18n/index.ts';
import { routeFor } from '#lib/nav/index.ts';
import { vehicleLiveHref } from '#lib/features/vehicles/vehicleLinks.ts';

export { delayTone } from '#lib/site/delayPresentation.ts';
import type { MapSelectionDetail, MapStopRef, RouteMapDetail } from './mapSelectionSession.svelte';
import { MAP_SELECTION_DETAIL_COPY } from './mapSelectionDetail.copy';

export type DetailAction = { readonly href: string; readonly label: string };

export function detailIdentity(
	detail: MapSelectionDetail,
	locale: Locale,
	line = (id: string) => id,
): string {
	const t = MAP_SELECTION_DETAIL_COPY[locale];
	if (detail.kind === 'vehicle') return `${t.bus} ${detail.vehicle.id}`;
	if (detail.kind === 'route') return `${t.route} ${line(detail.id)}`;
	return stopDisplayName(
		{
			id: detail.stop.id,
			name: detail.stop.name || detail.stop.id,
			seq: null,
			nameAbsent: (detail.stop as { nameAbsent?: boolean }).nameAbsent ?? !detail.stop.name,
		},
		locale,
	);
}

export function detailActions(
	detail: MapSelectionDetail,
	locale: Locale,
	line = (id: string) => id,
	source = new URL('https://transit.local'),
): DetailAction | null {
	const t = MAP_SELECTION_DETAIL_COPY[locale];
	if (detail.kind === 'route') {
		return {
			href: localizeHref(routeFor({ kind: 'line', id: detail.id }), locale),
			label: t.openFullRoute(line(detail.id)),
		};
	}
	if (detail.kind === 'stop') {
		return {
			href: localizeHref(routeFor({ kind: 'stop', id: detail.stop.id }), locale),
			label: t.openFullStop(detail.stop.id),
		};
	}
	if (detail.vehicle.trip) {
		return {
			href: vehicleLiveHref(detail.vehicle.id, source, locale),
			label: t.openFullVehicle(detail.vehicle.id),
		};
	}
	return detail.vehicle.route
		? {
				href: localizeHref(routeFor({ kind: 'line', id: detail.vehicle.route }), locale),
				label: t.openFullRoute(line(detail.vehicle.route)),
			}
		: null;
}

export function timeLabel(
	iso: string | null | undefined,
	locale: Locale,
	timeZone?: string,
): string {
	if (!iso) return '';
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return '·';
	// Without the published network zone there is no honest reader clock: the host's
	// zone would silently show a different city's time.
	if (!timeZone) return '·';
	return clockTime(date, locale, timeZone);
}

export function formatAge(seconds: number): string {
	return seconds < 90 ? `${Math.round(seconds)} s` : `${Math.round(seconds / 60)} min`;
}

export function stopDisplayName(ref: MapStopRef, locale: Locale): string {
	return ref.nameAbsent ? stopNameFallback(ref.id, locale) : displayStop(ref.name);
}

export function directionLabel(item: RouteMapDetail, locale: Locale): string {
	if (item.directions.length === 1)
		return item.directions[0]?.label ?? absenceShort('not-in-schedule', locale);
	return item.directions.length > 0
		? item.directions.map((direction) => direction.label).join(' / ')
		: absenceShort('not-in-schedule', locale);
}
