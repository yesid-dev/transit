import { describe, expect, it } from 'vitest';
import { csvCell, csvCount, csvPercent, downloadCsv, type CsvContext } from './recordCsv';

const context: CsvContext = {
	providerId: 'octranspo',
	providerName: 'OC Transpo',
	lineId: '6/a ?é',
	lineName: 'Greenboro',
	locale: 'fr',
	origin: 'https://transit.example',
};
const source = {
	source: 'retained_partitions',
	scope: { kind: 'window', from: '2026-10-01', to: '2026-10-03' },
	publication: { generatedUtc: null, generationId: 'retained@g1', methodVersion: null },
};

describe('line Record flat CSV', () => {
	it('keeps numeric delays and zero separate from absent and impossible values', () => {
		expect([0, -0, -1.25, null, NaN, Infinity].map(csvCell)).toEqual([
			'0',
			'0',
			'-1.25',
			'',
			'',
			'',
		]);
		expect([0, -1, 1.5, Infinity, null].map(csvCount)).toEqual([0, null, null, null, null]);
		expect([0, 100, -1, 101, NaN, null].map(csvPercent)).toEqual([0, 100, null, null, null, null]);
	});
	it('quotes text/newlines and protects formula prefixes including format and control characters', () => {
		expect(csvCell('Station, "Central"\nPlatform')).toBe('"Station, ""Central""\nPlatform"');
		for (const marker of ['=', '+', '-', '@'])
			expect(csvCell('\u200b\u0000 \t' + marker + 'SUM(A1)')).toBe(
				'"\'\u200b\u0000 \t' + marker + 'SUM(A1)"',
			);
		expect(csvCell('-2')).toBe('"\'-2"');
	});
	it('carries only its own source identity and dates, literal values and an absolute provider-locale opaque-ID URL', () => {
		const file = downloadCsv(
			context,
			source,
			'stop-delays',
			['stop_id', 'late_share_pct'],
			[
				{
					cells: ['x/y', 0],
					measure: 'readings_more_than_5_minutes_late',
					unit: '%',
					readings: 30,
				},
			],
		)!;
		expect(file.filename).toBe(
			'line-6%2Fa%20%3F%C3%A9-stop-delays-2026-10-01-2026-10-03-displayed-rows.csv',
		);
		expect(file.csv.split('\r\n')).toHaveLength(2);
		expect(file.csv).toContain(
			'"retained_partitions","octranspo","OC Transpo","6/a ?é","Greenboro","fr","window","2026-10-01","2026-10-03"',
		);
		expect(file.csv).toContain(
			',"readings_more_than_5_minutes_late","%",30,"","","published","","retained@g1","",',
		);
		expect(file.csv).toContain(
			'"https://transit.example/fr/lines/6%2Fa%20%3F%C3%A9?provider=octranspo&from=2026-10-01&to=2026-10-03&generation=retained%40g1","","x/y",0',
		);
		expect(decodeURIComponent(file.href.slice(file.href.indexOf(',') + 1))).toBe(
			'\ufeff' + file.csv,
		);
	});
	it('does not turn unsupported scopes, empty blocks or missing context into ready files', () => {
		expect(
			downloadCsv(context, { ...source, scope: { kind: 'none' } }, 'x', [], [{ cells: [] }]),
		).toBeNull();
		expect(downloadCsv(context, source, 'x', [], [])).toBeNull();
		expect(downloadCsv(undefined, source, 'x', [], [{ cells: [] }])).toBeNull();
	});
	it('keeps an undated mix’s grain in its record link without invented dates', () => {
		const file = downloadCsv(
			context,
			{ ...source, scope: { kind: 'undated_day_mix' } },
			'crowding-mix',
			['value_pct'],
			[{ unit: '%', cells: [100] }],
		)!;
		expect(file.csv).toContain('?provider=octranspo&grain=day&generation=retained%40g1');
		expect(file.filename).toContain('undated_day_mix-displayed-rows.csv');
		expect(file.csv).not.toContain('2026-10-01');
	});
});
