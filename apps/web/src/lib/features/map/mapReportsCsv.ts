import type { MapReportModel, MapReportRow } from './mapReports';

/**
 * Fixed export contract, in this order. Metadata repeats on every row so one row can be read
 * without the header context; the names are chosen once here and asserted in the tests.
 */
export const MAP_REPORT_CSV_COLUMNS = Object.freeze([
	'provider',
	'provider_name',
	'locale',
	'report_scope',
	'active_filters',
	'view_center_lon',
	'view_center_lat',
	'view_zoom',
	'view_bearing',
	'view_pitch',
	'view_width_px',
	'view_height_px',
	'view_bbox_west',
	'view_bbox_south',
	'view_bbox_east',
	'view_bbox_north',
	'source_generated_utc',
	'publication_generation_id',
	'methodology_version',
	'time_zone',
	'evaluated_utc',
	'attribution',
	'vehicle_id',
	'route_id',
	'trip_id',
	'next_stop_id',
	'status',
	'occupancy',
	'delay_min',
	'reported_utc',
	'updated_utc',
	'report_age_basis',
	'report_age_seconds',
	'no_recent_position',
	'latitude',
	'longitude',
] as const);

export interface MapReportCsv {
	readonly csv: string;
	readonly href: string;
	readonly filename: string;
}

/** Text is always quoted and spreadsheet-safe; a real zero stays 0, never -0. */
function textCell(value: string | null | undefined): string {
	const text = typeof value === 'string' ? value : '';
	const safe = /^[\s\p{Cc}\p{Cf}]*[=+\-@]/u.test(text) ? "'" + text : text;
	return '"' + safe.replaceAll('"', '""') + '"';
}

function numericCell(value: number | null | undefined): string {
	if (value == null || !Number.isFinite(value)) return '';
	return String(value === 0 ? 0 : value);
}

function providerToken(providerId: string): string {
	const safe = providerId
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40);
	return safe || 'provider';
}

function rowCells(model: MapReportModel, row: MapReportRow): readonly string[] {
	const { camera } = model;
	return [
		textCell(model.providerId),
		textCell(model.providerName),
		textCell(model.locale),
		textCell(model.scope),
		textCell(model.filters.join(';')),
		numericCell(camera.center[0]),
		numericCell(camera.center[1]),
		numericCell(camera.zoom),
		numericCell(camera.bearing),
		numericCell(camera.pitch),
		numericCell(camera.width),
		numericCell(camera.height),
		numericCell(camera.bbox.west),
		numericCell(camera.bbox.south),
		numericCell(camera.bbox.east),
		numericCell(camera.bbox.north),
		textCell(model.generatedUtc),
		textCell(model.publicationGenerationId),
		textCell(model.methodologyVersion),
		textCell(model.timeZone),
		textCell(model.evaluatedUtc),
		textCell(model.attribution),
		textCell(row.vehicleId),
		textCell(row.routeId),
		textCell(row.tripId),
		textCell(row.nextStopId),
		textCell(row.status),
		textCell(row.occupancy),
		numericCell(row.delayMin),
		textCell(row.reportedUtc),
		textCell(row.updatedUtc),
		textCell(row.ageBasis),
		numericCell(row.ageSeconds),
		textCell(row.noRecentPosition ? 'true' : 'false'),
		// Raw source coordinates only: estimated motion never enters an observation export.
		numericCell(row.lat),
		numericCell(row.lon),
	];
}

/**
 * The displayed report rows, in displayed order, from the captured model. A valid scope with no
 * rows still yields its header; callers pass only a ready model.
 */
export function mapReportsCsv(model: MapReportModel): MapReportCsv {
	const csv = [
		MAP_REPORT_CSV_COLUMNS.map(textCell).join(','),
		...model.rows.map((row) => rowCells(model, row).join(',')),
	].join('\r\n');
	return {
		csv,
		href: 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv),
		filename: `map-reports-${providerToken(model.providerId)}-${model.locale}.csv`,
	};
}
