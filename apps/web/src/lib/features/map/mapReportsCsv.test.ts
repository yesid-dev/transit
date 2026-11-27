import { describe, expect, it } from 'vitest';
import { csvDataText, csvText } from '../../../tests/csv.ts';
import { emptyFilterState } from '#lib/filters/index.ts';
import type { Vehicle, VehiclesFile } from '#lib/v1/schemas/index.ts';
import { buildMapReportView, mapReportFilterTokens } from './mapReports';
import { MAP_REPORT_CSV_COLUMNS, mapReportsCsv } from './mapReportsCsv';
import type { MapReportCamera } from './mapReportCamera';

const NOW = Date.parse('2026-11-16T21:00:00Z');
const camera: MapReportCamera = {
	center: [-73.6, 45.5],
	zoom: 11,
	bearing: 0,
	pitch: 0,
	width: 1000,
	height: 1000,
	bbox: { west: -74, south: 45, east: -73, north: 46 },
	project: ([lon, lat]) => ({ x: (lon + 74) * 1000, y: (46 - lat) * 1000 }),
};

function vehicle(overrides: Record<string, unknown> = {}): Vehicle {
	return {
		id: 'bus-1',
		lat: 45.5,
		lon: -73.6,
		status: 'late',
		delay_min: 3,
		updated_utc: '2026-11-16T20:59:30Z',
		trip: 'trip-1',
		route: '24',
		next_stop: 'stop-1',
		...overrides,
	} as unknown as Vehicle;
}

function capturedCsv(vehicles: Vehicle[], overrides: Record<string, unknown> = {}) {
	const view = buildMapReportView({
		source: {
			generated_utc: '2026-11-16T20:59:40Z',
			publish_generation_id: 'gen-1',
			methodology_version: 'm1',
			vehicles,
		} as unknown as VehiclesFile,
		health: { retained: true, failing: false, stale: false },
		filter: emptyFilterState(),
		alertVehicleIds: new Set<string>(),
		camera,
		serverNow: NOW,
		staleCutoffS: 150,
		providerId: 'stm',
		providerName: 'STM',
		locale: 'en',
		timeZone: 'America/Toronto',
		attribution: 'Source credit',
		filters: ['route:24'],
		...overrides,
	});
	if (view.kind !== 'ready') throw new Error('expected a ready view');
	return mapReportsCsv(view.model);
}

/** A minimal RFC 4180 reader, so the assertions run on parsed bytes, not the writer's intent. */
function parse(body: string): string[][] {
	const csv = csvText(body);
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = '';
	let quoted = false;
	for (let i = 0; i < csv.length; i += 1) {
		const char = csv[i];
		if (quoted) {
			if (char === '"' && csv[i + 1] === '"') {
				cell += '"';
				i += 1;
			} else if (char === '"') quoted = false;
			else cell += char;
		} else if (char === '"') quoted = true;
		else if (char === ',') {
			row.push(cell);
			cell = '';
		} else if (char === '\r' && csv[i + 1] === '\n') {
			row.push(cell);
			rows.push(row);
			row = [];
			cell = '';
			i += 1;
		} else cell += char;
	}
	if (cell.length > 0 || row.length > 0) {
		row.push(cell);
		rows.push(row);
	}
	return rows;
}

function record(csv: string): Record<string, string> {
	const [header, values] = parse(csv);
	return Object.fromEntries(header!.map((key, index) => [key, values![index] ?? '']));
}

describe('map report CSV', () => {
	it('keeps alert-filter provenance separate from vehicle publication and retains its warning state', () => {
		const filter = { ...emptyFilterState(), alerts: ['has_alert' as const] };
		const row = record(
			capturedCsv([vehicle()], {
				filter,
				filters: mapReportFilterTokens(filter),
				alertVehicleIds: new Set(['bus-1']),
				alertPublication: {
					generated_utc: '2026-11-16T20:58:00Z',
					publish_generation_id: 'alert-gen',
					methodology_version: 'alert-method',
				},
				alertHealth: { retained: true, failing: true, stale: true },
			}).csv,
		);
		expect(row).toMatchObject({
			source_generated_utc: '2026-11-16T20:59:40Z',
			publication_generation_id: 'gen-1',
			alert_filter_generated_utc: '2026-11-16T20:58:00Z',
			alert_filter_generation_id: 'alert-gen',
			alert_filter_methodology_version: 'alert-method',
			alert_filter_data_state: 'last_available',
		});
	});

	it('exports an unambiguous filter vector when literal IDs contain separators', () => {
		const filter = emptyFilterState();
		filter.routes.add('a;stop:b');
		filter.vehicles.add('bus,branch');
		const row = record(
			capturedCsv([vehicle({ id: 'bus,branch', route: 'a;stop:b' })], {
				filter,
				filters: mapReportFilterTokens(filter),
			}).csv,
		);
		expect(JSON.parse(row.active_filters)).toEqual(['route:a;stop:b', 'vehicle:bus,branch']);
	});

	it('writes the fixed header in the documented order', () => {
		const [header] = parse(capturedCsv([vehicle()]).csv);
		expect(header).toEqual([
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
			'alert_filter_generated_utc',
			'alert_filter_generation_id',
			'alert_filter_methodology_version',
			'alert_filter_data_state',
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
		]);
	});

	it('exports the captured metadata and the raw source row', () => {
		const csv = capturedCsv([vehicle()]).csv;
		const row = record(csv);
		expect(row).toMatchObject({
			provider: 'stm',
			provider_name: 'STM',
			locale: 'en',
			report_scope: 'matching_vehicle_reports_in_current_map_view',
			active_filters: '["route:24"]',
			view_center_lon: '-73.6',
			view_center_lat: '45.5',
			view_zoom: '11',
			view_width_px: '1000',
			view_bbox_west: '-74',
			source_generated_utc: '2026-11-16T20:59:40Z',
			publication_generation_id: 'gen-1',
			methodology_version: 'm1',
			alert_filter_generated_utc: '',
			alert_filter_generation_id: '',
			alert_filter_methodology_version: '',
			alert_filter_data_state: 'not_used',
			time_zone: 'America/Toronto',
			evaluated_utc: '2026-11-16T21:00:00.000Z',
			attribution: 'Source credit',
			vehicle_id: 'bus-1',
			route_id: '24',
			trip_id: 'trip-1',
			next_stop_id: 'stop-1',
			status: 'late',
			delay_min: '3',
			reported_utc: '',
			updated_utc: '2026-11-16T20:59:30Z',
			report_age_basis: 'updated_utc',
			report_age_seconds: '30',
			no_recent_position: 'false',
			latitude: '45.5',
			longitude: '-73.6',
		});
	});

	it('keeps a real zero, a signed delay and unknown values honest', () => {
		const csv = capturedCsv([
			vehicle({ id: 'zero', delay_min: 0, occupancy: 'empty' }),
			vehicle({ id: 'early', delay_min: -2, occupancy: null }),
			vehicle({ id: 'unknown', delay_min: null }),
			vehicle({ id: 'negative-zero', delay_min: -0 }),
		]).csv;
		const rows = parse(csv)
			.slice(1)
			.map((values) =>
				Object.fromEntries(parse(csv)[0]!.map((key, index) => [key, values[index]])),
			);
		expect(rows[0]).toMatchObject({ delay_min: '0', occupancy: 'empty' });
		expect(rows[1]).toMatchObject({ delay_min: '-2', occupancy: '' });
		expect(rows[2]).toMatchObject({ delay_min: '', reported_utc: '', occupancy: '' });
		expect(rows[3]).toMatchObject({ delay_min: '0' });
		expect(rows[0]!.no_recent_position).toBe('false');
	});

	it('marks no recent position and its overlapping row without changing the row count', () => {
		const csv = capturedCsv([
			vehicle({ id: 'old', updated_utc: '2026-11-16T20:57:00Z' }),
			vehicle({ id: 'fresh', updated_utc: '2026-11-16T20:59:00Z' }),
		]).csv;
		const rows = parse(csv);
		expect(rows).toHaveLength(3);
		expect(rows[1]![MAP_REPORT_CSV_COLUMNS.indexOf('no_recent_position')]).toBe('true');
		expect(rows[2]![MAP_REPORT_CSV_COLUMNS.indexOf('no_recent_position')]).toBe('false');
	});

	it('quotes, escapes and neutralizes spreadsheet formulas in text cells', () => {
		const csv = capturedCsv([vehicle({ id: '=SUM(A1)', route: '+24, "express"\nnext' })], {
			providerName: '@STM\t=cmd',
			attribution: '  =credit',
		}).csv;
		const parsed = parse(csv);
		const values = parsed[1]!;
		const row = Object.fromEntries(parsed[0]!.map((key, index) => [key, values[index] ?? '']));
		expect(row.provider_name).toBe("'@STM\t=cmd");
		expect(row.attribution).toBe("'  =credit");
		expect(row.vehicle_id).toBe("'=SUM(A1)");
		expect(row.route_id).toBe(`'+24, "express"\nnext`);
		expect(parsed).toHaveLength(2);
	});

	it('never exports an estimated position', () => {
		const csv = capturedCsv([vehicle({ id: 'raw', lon: -73.6123, lat: 45.5012 })]).csv;
		const row = record(csv);
		expect(row.latitude).toBe('45.5012');
		expect(row.longitude).toBe('-73.6123');
	});

	it('allows a header-only file for a valid scope with no matches', () => {
		const file = capturedCsv([]);
		const rows = parse(file.csv);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual([...MAP_REPORT_CSV_COLUMNS]);
		expect(file.filename).toBe('map-reports-stm-en.csv');
	});

	it('sanitizes the provider in the filename and never turns identifiers into paths', () => {
		const file = capturedCsv([vehicle()], {
			providerId: '../../STM / Montréal',
			source: {
				generated_utc: '2026-11-16T20:59:40Z',
				vehicles: [vehicle({ id: '../etc/passwd' })],
			},
		});
		expect(file.filename).toBe('map-reports-stm-montr-al-en.csv');
		expect(file.filename).not.toContain('/');
		expect(csvDataText(file.href)).toBe(file.csv);
	});

	it('exports exactly the captured model even if the live source later changes', () => {
		const captured = capturedCsv([vehicle({ id: 'captured' })]);
		const rows = parse(captured.csv);
		expect(rows[1]![MAP_REPORT_CSV_COLUMNS.indexOf('vehicle_id')]).toBe('captured');
		// The captured string is the rendered model; no live read happens at download time.
		expect(captured.csv).toBe(capturedCsv([vehicle({ id: 'captured' })]).csv);
		expect(captured.csv).not.toContain('later');
	});
});
