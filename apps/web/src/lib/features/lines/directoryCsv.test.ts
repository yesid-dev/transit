import { describe, expect, it } from 'vitest';
import type { RouteIndexEntry } from '#lib/v1/index.ts';
import type { DirectoryEvidence } from './directoryState';
import {
	csvHref,
	DISPLAYED_CSV_FILENAME,
	directoryCsv,
	selectedRecordCsv,
	selectedRecordFilename,
	type DirectoryCsvRow,
} from './directoryCsv';

const line = (id: string, long = `Line ${id}`): RouteIndexEntry => ({
	id,
	short: id,
	long,
	type: 3,
});

const publication = {
	generatedUtc: '2026-11-11T05:00:00Z',
	generationId: 'stm@2026-11-11T05:00:00Z',
	methodVersion: 'reliability-2',
};

function evidence(overrides: Partial<DirectoryEvidence> = {}): DirectoryEvidence {
	return {
		state: 'figure',
		source: 'current_route_record',
		percent: 82,
		readings: 1000,
		from: '2026-11-04',
		to: '2026-11-10',
		days: 7,
		publication,
		hedge: null,
		verdictStatus: 'reliable',
		classification: 'reliable',
		excluded: null,
		older: false,
		...overrides,
	};
}

const row = (overrides: Partial<DirectoryCsvRow> = {}): DirectoryCsvRow => ({
	line: line('24'),
	ranked: false,
	evidence: evidence(),
	...overrides,
});

const input = (rows: readonly DirectoryCsvRow[]) => ({
	rows,
	providerId: 'stm',
	providerName: 'STM',
	locale: 'en' as const,
	origin: 'https://transit.yesid.dev',
	modeTag: () => 'Bus',
	recordHref: (csvRow: DirectoryCsvRow) =>
		`/lines/${csvRow.line.id}?provider=stm&from=${csvRow.evidence.from ?? ''}&to=${
			csvRow.evidence.to ?? ''
		}`,
});

function cells(csv: string, index: number): string[] {
	return csv.split('\r\n')[index].split(',');
}

describe('directory CSV — displayed rows', () => {
	it('exports exactly the rows shown, in order, with their own source and window', () => {
		const csv = directoryCsv(
			input([
				row({
					line: line('77'),
					ranked: true,
					evidence: evidence({
						source: 'published_weekly_index',
						percent: 40,
						readings: 100,
						publication: { generatedUtc: null, generationId: null, methodVersion: null },
					}),
				}),
				row({
					line: line('2'),
					evidence: evidence({
						state: 'unranked',
						source: 'published_weekly_index',
						percent: null,
						readings: null,
						excluded: 'too_few_units',
					}),
				}),
			]),
		);
		const lines = csv.split('\r\n');
		expect(lines).toHaveLength(3);
		expect(cells(csv, 1)).toEqual([
			'"stm"',
			'"STM"',
			'"77"',
			'"77"',
			'"Line 77"',
			'"Bus"',
			'"share_of_readings_on_time"',
			'"%"',
			'40',
			'100',
			'"2026-11-04"',
			'"2026-11-10"',
			'7',
			'"figure"',
			'""',
			'""',
			'""',
			'""',
			'"published_weekly_index"',
			'""',
			'"https://transit.yesid.dev/lines/77?provider=stm&from=2026-11-04&to=2026-11-10"',
		]);
		// The second row keeps its own state and reason, and never borrows an ordinary figure.
		expect(cells(csv, 2).slice(8, 15)).toEqual([
			'',
			'',
			'"2026-11-04"',
			'"2026-11-10"',
			'7',
			'"unranked"',
			'"too_few_units"',
		]);
		expect(cells(csv, 2)[18]).toBe('"published_weekly_index"');
	});

	it('keeps a measured zero as 0 and an unknown as an empty cell', () => {
		const csv = directoryCsv(
			input([
				row({ evidence: evidence({ percent: 0, readings: 30 }) }),
				row({
					line: line('25'),
					evidence: evidence({
						state: 'not-published',
						percent: null,
						readings: null,
						from: null,
						to: null,
						days: null,
					}),
				}),
			]),
		);
		expect(cells(csv, 1).slice(8, 13)).toEqual(['0', '30', '"2026-11-04"', '"2026-11-10"', '7']);
		expect(cells(csv, 2).slice(8, 13)).toEqual(['', '', '""', '""', '']);
	});

	it('never writes NaN, Infinity or -0 into a numeric cell', () => {
		const csv = directoryCsv(
			input([
				row({ evidence: evidence({ percent: Number.NaN }) }),
				row({
					line: line('25'),
					evidence: evidence({ percent: Number.POSITIVE_INFINITY, readings: -0 }),
				}),
			]),
		);
		expect(cells(csv, 1)[8]).toBe('');
		expect(cells(csv, 2)[8]).toBe('');
		expect(cells(csv, 2)[9]).toBe('0');
	});

	it('quotes text, escapes embedded quotes, keeps newlines and defuses formulas', () => {
		const csv = directoryCsv(
			input([
				row({
					line: line('24', 'Sherbrooke, "Rive-Sud"\nTerminus'),
					evidence: evidence({ publication: { ...publication, generationId: '=HYPERLINK("x")' } }),
				}),
				row({ line: line('25', '  \t=SUM(A1)') }),
			]),
		);
		expect(csv).toContain('"Sherbrooke, ""Rive-Sud""\nTerminus"');
		expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
		expect(csv).toContain(`"'  \t=SUM(A1)"`);
	});

	it('names the provider on every row and offers the same browser download shape', () => {
		const csv = directoryCsv(input([row()]));
		expect(cells(csv, 1)[0]).toBe('"stm"');
		expect(cells(csv, 1)[1]).toBe('"STM"');
		expect(DISPLAYED_CSV_FILENAME).toBe('lines-displayed-records.csv');
		expect(csvHref(csv).startsWith('data:text/csv;charset=utf-8,')).toBe(true);
		expect(decodeURIComponent(csvHref(csv).split(',').slice(1).join(','))).toBe(csv);
	});
});

describe('directory CSV — the selected record', () => {
	it('exports one record with its own dates, identity and link', () => {
		const selected = row({ line: line('24'), evidence: evidence({ percent: 82, readings: 1000 }) });
		const csv = selectedRecordCsv(input([selected]))!;
		expect(csv.split('\r\n')).toHaveLength(2);
		expect(cells(csv, 1).slice(2, 5)).toEqual(['"24"', '"24"', '"Line 24"']);
		expect(cells(csv, 1)[8]).toBe('82');
		expect(cells(csv, 1).slice(15, 19)).toEqual([
			'"2026-11-11T05:00:00Z"',
			'"stm@2026-11-11T05:00:00Z"',
			'"reliability-2"',
			'"current_route_record"',
		]);
		expect(selectedRecordFilename(selected)).toBe(
			'line-24-2026-11-04-2026-11-10-selected-record.csv',
		);
	});

	it('refuses a selection without a real figure or complete days', () => {
		expect(
			selectedRecordCsv(
				input([row({ evidence: evidence({ state: 'not-published', percent: null }) })]),
			),
		).toBeNull();
		expect(
			selectedRecordCsv(input([row({ evidence: evidence({ state: 'unranked', percent: null }) })])),
		).toBeNull();
		expect(selectedRecordCsv(input([row({ evidence: evidence({ from: null }) })]))).toBeNull();
		expect(selectedRecordFilename(null)).toBeNull();
		expect(selectedRecordFilename(row({ evidence: evidence({ from: null }) }))).toBeNull();
	});

	it('keeps the comparison’s own source separate from a current-file record', () => {
		const compared = selectedRecordCsv(
			input([
				row({
					ranked: true,
					evidence: evidence({
						source: 'published_weekly_index',
						percent: 40,
						readings: 100,
						publication: {
							generatedUtc: '2026-11-11T05:00:00Z',
							generationId: null,
							methodVersion: null,
						},
					}),
				}),
			]),
		)!;
		expect(cells(compared, 1)[18]).toBe('"published_weekly_index"');
		expect(cells(compared, 1)[15]).toBe('"2026-11-11T05:00:00Z"');
		expect(cells(compared, 1)[16]).toBe('""');
		expect(cells(compared, 1)[17]).toBe('""');
	});
});

describe('directory CSV definition and provenance guards', () => {
	it('never invents operator attribution and preserves attribution only when supplied', () => {
		expect(cells(directoryCsv(input([row()])), 1)[19]).toBe('""');
		expect(
			cells(
				directoryCsv({ ...input([row()]), attribution: 'Agency open-data attribution' }),
				1,
			)[19],
		).toBe('"Agency open-data attribution"');
	});

	it('keeps zero readings as a count while withholding the undefined share', () => {
		const item = row({ evidence: evidence({ state: 'low-sample', percent: null, readings: 0 }) });
		const csv = directoryCsv(input([item]));
		expect(cells(csv, 1)[8]).toBe('');
		expect(cells(csv, 1)[9]).toBe('0');
		expect(selectedRecordCsv(input([item]))).toBeNull();
	});

	it.each([
		{ percent: Number.NaN },
		{ percent: Number.POSITIVE_INFINITY },
		{ percent: -1 },
		{ percent: 101 },
		{ percent: 50.5 },
		{ readings: 0 },
		{ readings: -1 },
		{ readings: 29 },
		{ readings: 30.5 },
		{ state: 'unranked' as const },
		{ days: 6 },
		{ from: '2026-02-30' },
	])('offers no selected download for unsupported evidence: %j', (invalid) => {
		const item = row({ evidence: evidence(invalid) });
		expect(selectedRecordCsv(input([item]))).toBeNull();
		expect(selectedRecordFilename(item)).toBeNull();
	});

	it('preserves opaque line identity in a safe filename instead of collapsing identifiers', () => {
		const item = row({ line: line('Ligné/中央 :01') });
		expect(selectedRecordFilename(item)).toBe(
			`line-${encodeURIComponent(item.line.id)}-2026-11-04-2026-11-10-selected-record.csv`,
		);
	});

	it('exports absolute provider- and locale-preserving links', () => {
		const csv = directoryCsv({
			...input([row()]),
			providerId: 'octranspo',
			providerName: 'OC Transpo',
			origin: 'https://transit.yesid.dev',
			recordHref: () => '/fr/lines/24?provider=octranspo&from=2026-11-04&to=2026-11-10',
		});
		expect(cells(csv, 1)[20]).toBe(
			'"https://transit.yesid.dev/fr/lines/24?provider=octranspo&from=2026-11-04&to=2026-11-10"',
		);
	});

	it('does not export a source link for a different provider or application origin', () => {
		for (const href of [
			'/lines/24?provider=octranspo',
			'https://example.test/lines/24?provider=stm',
		]) {
			const csv = directoryCsv({ ...input([row()]), recordHref: () => href });
			expect(cells(csv, 1)[20]).toBe('""');
		}
	});
});
