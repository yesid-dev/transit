import { describe, expect, it } from 'vitest';
import { TripsFileSchema } from '#lib/v1/schemas/index.ts';
import { reportedOffset, tripReportCsv } from './tripReportCsv';

const report = TripsFileSchema.parse({
	generated_utc: '2026-06-15T12:00:00Z',
	trips: {
		T1: {
			status: 'late',
			route: '1-373',
			delay_min: -2,
			stops: [{ stop: 's1', eta_utc: '2026-06-15T12:05:00Z', delay_min: -2 }],
		},
	},
});
const input = {
	provider: 'octranspo',
	tripId: 'T1',
	trip: report.trips.T1,
	report,
	timeZone: 'America/Vancouver',
	stopNames: { s1: 'Published stop' },
};
const header =
	'"provider","trip_id","line_id","schema_version","methodology_version","publish_generation_id","report_generated_utc","feed_captured_utc","time_zone","stop_id","stop_name","predicted_utc","reported_offset_min"';

describe('trip report export', () => {
	it('exports the reported context and a negative numeric offset in fixed columns', () => {
		expect(tripReportCsv(input)).toBe(
			header +
				'\r\n"octranspo","T1","1-373",,"","","2026-06-15T12:00:00Z","","America/Vancouver","s1","Published stop","2026-06-15T12:05:00Z",-2',
		);
	});

	it('keeps the supplied schema, string methodology, generation and capture time separate', () => {
		const csv = tripReportCsv({
			...input,
			report: TripsFileSchema.parse({
				...report,
				schema_version: 1,
				methodology_version: 'live-2',
				publish_generation_id: 'octranspo@2026-06-15T12:00:00Z',
				feed_captured_utc: '2026-06-15T11:57:00Z',
			}),
		});
		expect(csv).toContain(
			'"1-373",1,"live-2","octranspo@2026-06-15T12:00:00Z","2026-06-15T12:00:00Z","2026-06-15T11:57:00Z","America/Vancouver"',
		);
		const other = tripReportCsv({
			...input,
			report: {
				...report,
				schema_version: 8,
				methodology_version: 'different-method',
				publish_generation_id: 'supplied-generation',
			},
		});
		expect(other).toContain(',8,"different-method","supplied-generation",');
	});
	it('exports only the header for zero predictions', () => {
		expect(tripReportCsv({ ...input, trip: { ...input.trip, stops: [] } })).toBe(header);
	});
	it('does not export a fallback identifier as a published stop name', () => {
		expect(tripReportCsv({ ...input, stopNames: {} })).toContain(
			'"s1","","2026-06-15T12:05:00Z",-2',
		);
	});
	it.each([
		'=2+2',
		'+cmd',
		'-formula',
		'@SUM(A1)',
		' \t=2',
		'\u0000\r\n@SUM(A1)',
		'\uFEFF -formula',
	])('neutralizes formula-leading text %j without modifying numeric offsets', (name) => {
		const csv = tripReportCsv({ ...input, stopNames: { s1: name } });
		expect(csv).toContain('"\'' + name + '"');
		expect(csv.endsWith(',-2')).toBe(true);
	});
	it('quotes commas, double quotes and newlines without losing row order', () => {
		const csv = tripReportCsv({
			...input,
			stopNames: { s1: 'Station, "Central"\nPlatform' },
			trip: {
				...input.trip,
				stops: [...input.trip.stops!, { ...input.trip.stops![0], stop: 's2', delay_min: 0 }],
			},
		});
		expect(csv).toContain('"Station, ""Central""\nPlatform"');
		expect(csv.indexOf('"s1"')).toBeLessThan(csv.indexOf('"s2"'));
		expect(csv.endsWith(',0')).toBe(true);
	});
	it.each([
		[0, '0'],
		[-0, '0'],
		[-2, '-2'],
		[1.5, '1.5'],
		[null, ''],
		[Number.NaN, ''],
		[Infinity, ''],
		[-Infinity, ''],
	] as const)('keeps %s numerical or unavailable in both the report and export', (value, text) => {
		const normalized = reportedOffset(value);
		expect(normalized).toBe(text === '' ? null : Number(text));
		expect(Object.is(normalized, -0)).toBe(false);
		expect(
			tripReportCsv({
				...input,
				trip: { ...input.trip, stops: [{ ...input.trip.stops![0], delay_min: value }] },
			}).endsWith(',' + text),
		).toBe(true);
	});
});
