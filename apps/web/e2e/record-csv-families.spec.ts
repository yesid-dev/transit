import { expect, test } from '@playwright/test';

// One download from every family of record.csv routes, in both languages: a file a spreadsheet
// opens as it is (closing audit G4 S2).
const period = 'provider=stm&recordFrom=2026-11-08&recordTo=2026-11-14';
const families = [
	['overview', '/record.csv?section=punctuality'],
	['measure', '/metrics/record.csv?section=on_time'],
	['network', '/network/record.csv?section=poll_success'],
	['daily', '/receipt/record.csv?section=punctuality'],
	['alerts', '/alerts/record.csv?section=answer'],
	['line-24', '/lines/24/record.csv?section=punctuality'],
	['stop-S1', '/stop/S1/record.csv?section=hourly'],
	['departure-24-0-0700', '/departure/24-0-0700/record.csv?section=observed'],
	['vehicles', '/vehicles/record.csv?section=fleet'],
	['vehicle-40061', '/vehicle/40061/record.csv?section=service'],
	['rankings-line', '/rankings/record.csv?kind=line'],
] as const;

function records(text: string) {
	// Split on line ends outside quotes.
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index]!;
		if (quoted) {
			if (char === '"' && text[index + 1] === '"') {
				field += '"';
				index++;
			} else if (char === '"') quoted = false;
			else field += char;
		} else if (char === '"') quoted = true;
		else if (char === ',') {
			row.push(field);
			field = '';
		} else if (char === '\r' && text[index + 1] === '\n') {
			row.push(field);
			rows.push(row);
			row = [];
			field = '';
			index++;
		} else field += char;
	}
	return rows;
}

for (const locale of ['en', 'fr'] as const)
	for (const [entity, path] of families)
		test(`${locale} ${entity} record.csv opens in a spreadsheet as it is`, async ({
			request,
		}, info) => {
			// A request check: one browser project is enough.
			test.skip(info.project.name !== 'desktop');
			// The site keeps downloads out of its locale routing: French asks under /fr itself.
			const href = `${locale === 'fr' ? '/fr' : ''}${path}&${period}`;
			const response = await request.get(href);
			expect(response.status(), href).toBe(200);
			const disposition = response.headers()['content-disposition'] ?? '';
			// Network, page, dates and language: two downloads never share a name.
			expect(disposition).toMatch(
				new RegExp(
					`filename="stm-${entity}[^"]*-\\d{4}-\\d\\d-\\d\\d(?:-to-[0-9-]+)?-${locale}\\.csv"`,
				),
			);
			const bytes = await response.body();
			expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
			const text = new TextDecoder().decode(bytes);
			// Every line ends with CRLF; a lone line feed only sits inside a quoted field.
			expect(text.endsWith('\r\n')).toBe(true);
			const [header, ...rows] = records(text);
			expect(header!.slice(-2)).toEqual(
				locale === 'fr'
					? ['Source des données et licence', 'Adresse de la licence']
					: ['Data source and licence', 'Licence URL'],
			);
			const measure = header!.indexOf(locale === 'fr' ? 'Mesure' : 'Measure');
			if (measure >= 0)
				expect(header![measure - 1]).toBe(
					locale === 'fr' ? 'Identifiant de la mesure' : 'Measure ID',
				);
			expect(rows.length).toBeGreaterThan(0);
			for (const row of rows) {
				expect(row).toHaveLength(header!.length);
				// One value per cell: no JSON object or list for a spreadsheet to choke on.
				for (const cell of row) expect(cell).not.toMatch(/^\s*[[{]/u);
				// A measure is named in the reader's language, never only by its ID.
				if (measure >= 0) expect(row[measure], row[measure - 1]).not.toBe(row[measure - 1]);
			}
		});
