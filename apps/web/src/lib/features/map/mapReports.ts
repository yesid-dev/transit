import type { Locale } from '#lib/i18n/index.ts';
import type { FilterState } from '#lib/filters/index.ts';
import type { Vehicle, VehiclesFile } from '#lib/v1/schemas/index.ts';
import { matchesFilter, inVehicleScope } from '#lib/components/map/vehicleLayer.ts';
import { fixAgeS, notReporting } from '#lib/components/map/vehicleProjection.ts';
import { mapReportCameraKey, type MapReportCamera } from './mapReportCamera';

/** The one scope sentence this list reports on. */
export const MAP_REPORT_SCOPE = 'matching_vehicle_reports_in_current_map_view';

export interface MapReportSourceHealth {
	/** The last successful file is still on screen. */
	readonly retained: boolean;
	/** The latest poll failed; the numbers belong to the retained file. */
	readonly failing: boolean;
	readonly stale: boolean;
	readonly loading?: boolean;
}

export interface MapReportPublication {
	readonly generated_utc: string;
	readonly publish_generation_id?: string | null;
	readonly methodology_version?: string | null;
}

export interface MapReportAlertContext {
	readonly generatedUtc: string;
	readonly generationId: string | null;
	readonly methodVersion: string | null;
	readonly dataState: 'current' | 'last_available';
}

export type MapReportAgeBasis = 'reported_utc' | 'updated_utc';

export interface MapReportRow {
	/** Source order and duplicates are preserved; this is the row's own position. */
	readonly index: number;
	readonly vehicleId: string;
	readonly routeId: string | null;
	readonly directionId?: number | null;
	readonly tripId: string | null;
	readonly nextStopId: string | null;
	readonly status: Vehicle['status'];
	readonly occupancy: Vehicle['occupancy'];
	readonly delayMin: number | null;
	readonly reportedUtc: string | null;
	readonly updatedUtc: string;
	readonly ageBasis: MapReportAgeBasis;
	/** Null when the source time cannot yield a finite age. */
	readonly ageSeconds: number | null;
	readonly noRecentPosition: boolean;
	/** Raw source coordinates, never an estimated position. */
	readonly lon: number;
	readonly lat: number;
}

export interface MapReportCameraView {
	readonly center: readonly [number, number];
	readonly zoom: number;
	readonly bearing: number;
	readonly pitch: number;
	readonly width: number;
	readonly height: number;
	readonly bbox: MapReportCamera['bbox'];
}

export interface MapReportModel {
	/** Changes when the source file, live filters or captured camera change. */
	readonly identity: string;
	readonly providerId: string;
	readonly providerName: string;
	readonly locale: Locale;
	readonly scope: typeof MAP_REPORT_SCOPE;
	readonly filters: readonly string[];
	readonly camera: MapReportCameraView;
	readonly generatedUtc: string;
	readonly publicationGenerationId: string | null;
	readonly methodologyVersion: string | null;
	/** The manifest's provider zone, labelled UTC when the manifest carries none. */
	readonly timeZone: string;
	readonly evaluatedEpochMs: number;
	readonly evaluatedUtc: string;
	readonly attribution: string | null;
	readonly sourceHealth: MapReportSourceHealth | null;
	readonly alertFilter: MapReportAlertContext | null;
	readonly rows: readonly MapReportRow[];
	readonly inViewCount: number;
	readonly noRecentInViewCount: number;
	/** Matching reports whose location cannot be assigned to any viewport. */
	readonly unscopedMatchingCount: number;
}

export type MapReportUnavailableReason = 'view' | 'source' | 'clock' | 'alerts';

export type MapReportView =
	| { readonly kind: 'loading'; readonly reason?: 'alerts' }
	| { readonly kind: 'unavailable'; readonly reason: MapReportUnavailableReason }
	| { readonly kind: 'ready'; readonly model: MapReportModel };

export interface MapReportInput {
	readonly source: VehiclesFile | null;
	readonly health: MapReportSourceHealth | null;
	readonly filter: FilterState;
	readonly alertVehicleIds: ReadonlySet<string>;
	/** Publication and health of the same alert input that produced alertVehicleIds. */
	readonly alertPublication?: MapReportPublication | null;
	readonly alertHealth?: MapReportSourceHealth | null;
	readonly camera: MapReportCamera | null;
	readonly serverNow: number;
	readonly staleCutoffS: number;
	readonly providerId: string;
	readonly providerName: string;
	readonly locale: Locale;
	readonly timeZone?: string | null;
	readonly attribution?: string | null;
	/** Locale-independent active live filters, shared by the list and the CSV. */
	readonly filters: readonly string[];
}

const WORLD = [-180, -90, 180, 90] as const;

function hasFiniteLocation(vehicle: Pick<Vehicle, 'lon' | 'lat'>): boolean {
	return (
		Number.isFinite(vehicle.lon) &&
		Number.isFinite(vehicle.lat) &&
		vehicle.lon >= WORLD[0] &&
		vehicle.lon <= WORLD[2] &&
		vehicle.lat >= WORLD[1] &&
		vehicle.lat <= WORLD[3]
	);
}

function reportRow(
	vehicle: Vehicle,
	index: number,
	serverNow: number,
	staleCutoffS: number,
): MapReportRow {
	const ageBasis: MapReportAgeBasis = vehicle.reported_utc ? 'reported_utc' : 'updated_utc';
	const rawAge = fixAgeS(vehicle.reported_utc, vehicle.updated_utc, serverNow);
	return {
		index,
		vehicleId: vehicle.id,
		routeId: vehicle.route ?? null,
		directionId: vehicle.direction_id ?? null,
		tripId: vehicle.trip ?? null,
		nextStopId: vehicle.next_stop ?? null,
		status: vehicle.status,
		occupancy: vehicle.occupancy ?? null,
		delayMin:
			typeof vehicle.delay_min === 'number' && Number.isFinite(vehicle.delay_min)
				? vehicle.delay_min
				: null,
		reportedUtc: vehicle.reported_utc ?? null,
		updatedUtc: vehicle.updated_utc,
		ageBasis,
		ageSeconds: Number.isFinite(rawAge) ? rawAge : null,
		noRecentPosition: notReporting(vehicle, serverNow, staleCutoffS) !== null,
		lon: vehicle.lon,
		lat: vehicle.lat,
	};
}

/**
 * One captured report view from one raw file, one copied filter scope, one settled camera and one
 * data-clock reading. The list, its headline counts and the downloaded CSV all read this model.
 */
export function buildMapReportView(input: MapReportInput): MapReportView {
	const { source, camera, filter, alertVehicleIds, serverNow, staleCutoffS } = input;
	if (!Number.isFinite(serverNow)) return { kind: 'unavailable', reason: 'clock' };
	if (!camera) return { kind: 'unavailable', reason: 'view' };
	if (!source) {
		const state = input.health;
		return state?.failing ? { kind: 'unavailable', reason: 'source' } : { kind: 'loading' };
	}
	if (!Array.isArray(source.vehicles)) return { kind: 'unavailable', reason: 'source' };
	const alertPublication = input.alertPublication ?? null;
	const alertUsed = (filter.alerts?.length ?? 0) > 0;
	if (alertUsed && !alertPublication)
		return input.alertHealth?.loading
			? { kind: 'loading', reason: 'alerts' }
			: { kind: 'unavailable', reason: 'alerts' };
	const alertFilter: MapReportAlertContext | null =
		alertUsed && alertPublication
			? {
					generatedUtc: alertPublication.generated_utc,
					generationId: alertPublication.publish_generation_id ?? null,
					methodVersion: alertPublication.methodology_version ?? null,
					dataState:
						!input.alertHealth || input.alertHealth.failing || input.alertHealth.stale
							? 'last_available'
							: 'current',
				}
			: null;

	const rows: MapReportRow[] = [];
	let unscopedMatchingCount = 0;
	for (const [index, vehicle] of source.vehicles.entries()) {
		if (!inVehicleScope(vehicle, filter)) continue;
		if (!matchesFilter(vehicle, filter, alertVehicleIds)) continue;
		if (!hasFiniteLocation(vehicle)) {
			unscopedMatchingCount += 1;
			continue;
		}
		const coord = [vehicle.lon, vehicle.lat] as const;
		const point = camera.project(coord);
		if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
			unscopedMatchingCount += 1;
			continue;
		}
		if (point.x < 0 || point.x > camera.width || point.y < 0 || point.y > camera.height) {
			// A valid position outside this view belongs to another viewport, not to an unknown one.
			continue;
		}
		rows.push(reportRow(vehicle, index, serverNow, staleCutoffS));
	}

	const filters = [...input.filters];
	const identity = JSON.stringify([
		input.providerId,
		source.generated_utc,
		source.publish_generation_id ?? '',
		source.methodology_version ?? '',
		filters,
		mapReportCameraKey(camera),
		alertFilter,
	]);

	return {
		kind: 'ready',
		model: {
			identity,
			providerId: input.providerId,
			providerName: input.providerName,
			locale: input.locale,
			scope: MAP_REPORT_SCOPE,
			filters,
			camera: {
				center: [camera.center[0], camera.center[1]],
				zoom: camera.zoom,
				bearing: camera.bearing,
				pitch: camera.pitch,
				width: camera.width,
				height: camera.height,
				bbox: { ...camera.bbox },
			},
			generatedUtc: source.generated_utc,
			publicationGenerationId: source.publish_generation_id ?? null,
			methodologyVersion: source.methodology_version ?? null,
			timeZone: input.timeZone?.trim() || 'UTC',
			evaluatedEpochMs: serverNow,
			evaluatedUtc: new Date(serverNow).toISOString(),
			attribution: input.attribution && input.attribution.trim() ? input.attribution : null,
			sourceHealth: input.health,
			alertFilter,
			rows,
			inViewCount: rows.length,
			noRecentInViewCount: rows.filter((row) => row.noRecentPosition).length,
			unscopedMatchingCount,
		},
	};
}

function sortedIds(values: ReadonlySet<string>): string[] {
	return [...values].sort();
}

/**
 * The live filter scope as stable, locale-independent tokens. Both the copied link and the CSV
 * describe exactly the filters the list applied.
 */
export function mapReportFilterTokens(filter: FilterState): string[] {
	const tokens: string[] = [];
	if (filter.showOutOfService) tokens.push('show_out_of_service:1');
	for (const id of sortedIds(filter.routes)) tokens.push(`route:${id}`);
	for (const id of sortedIds(filter.stops)) tokens.push(`stop:${id}`);
	for (const id of sortedIds(filter.trips)) tokens.push(`trip:${id}`);
	for (const id of sortedIds(filter.vehicles)) tokens.push(`vehicle:${id}`);
	for (const code of filter.status ?? []) tokens.push(`status:${code}`);
	for (const code of filter.occupancy ?? []) tokens.push(`occupancy:${code}`);
	if (filter.entities?.length === 0) tokens.push('entity:none');
	for (const kind of filter.entities ?? []) tokens.push(`entity:${kind}`);
	for (const kind of filter.alerts ?? []) tokens.push(`alert:${kind}`);
	return tokens;
}
