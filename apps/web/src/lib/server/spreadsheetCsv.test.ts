import { expect, it } from 'vitest';
import { csvText } from '../../tests/csv.ts';
import { scalarCell, spreadsheetCsv } from './spreadsheetCsv.ts';

const source = 'STM open data, CC BY 4.0, computed by Transit';
const licence = 'https://creativecommons.org/licenses/by/4.0/';

async function write(chunks: (string | Uint8Array)[], lang: 'en' | 'fr' = 'en') {
	const encoder = new TextEncoder();
	const input = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks)
				controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
			controller.close();
		},
	});
	const response = new Response(input.pipeThrough(spreadsheetCsv(lang, source, licence)));
	return new Uint8Array(await response.arrayBuffer());
}
const text = async (chunks: (string | Uint8Array)[], lang: 'en' | 'fr' = 'en') =>
	csvText(await write(chunks, lang));
const tail = `"${source}",${licence}`;

it('writes exactly one UTF-8 BOM, even when the source splits its own across chunks', async () => {
	for (const chunks of [
		['Measure\n'],
		[Uint8Array.of(0xef), Uint8Array.of(0xbb, 0xbf, ...new TextEncoder().encode('Measure\n'))],
	]) {
		const bytes = await write(chunks);
		expect([...bytes.slice(0, 4)]).toEqual([0xef, 0xbb, 0xbf, 0x4d]);
		expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)).toBe(
			'﻿Measure ID,Measure,Data source and licence,Licence URL\r\n',
		);
	}
});

it('puts the measure ID beside its name and names the source and licence on every row', async () => {
	expect(await text(['Measure,Value,Unit,State\non_time,0.8,Share,Measured\n'])).toBe(
		'Measure ID,Measure,Value,Unit,State,Data source and licence,Licence URL\r\n' +
			`on_time,On-time share,0.8,Share,Measured,${tail}\r\n`,
	);
	expect(await text(['Mesure,Valeur\r\non_time,0.8\r\n'], 'fr')).toBe(
		'Identifiant de la mesure,Mesure,Valeur,Source des données et licence,Adresse de la licence\r\n' +
			`on_time,Part à l’heure,0.8,"${source}",${licence}\r\n`,
	);
});

it('turns a row of several measures into one row per measure, with its own unit and state', async () => {
	const values = JSON.stringify({ early: 0.02, on_time: 0.97, median_delay: -8 });
	const units = JSON.stringify({ early: 'Share', on_time: 'Share', median_delay: 'Seconds' });
	const states = JSON.stringify({
		early: 'Measured',
		on_time: 'Measured',
		median_delay: 'Too few',
	});
	const field = (value: string) => `"${value.replaceAll('"', '""')}"`;
	const csv =
		'Stop ID,Measure,Value,Unit,State,Filters,Included days\r\n' +
		`50110,punctuality,${field(values)},${field(units)},${field(states)},${field('{"line": "51"}')},${field('["2026-11-19", "2026-11-20"]')}\r\n`;
	expect((await text([csv])).split('\r\n')).toEqual([
		'Stop ID,Measure ID,Measure,Value,Unit,State,Filters,Included days,Data source and licence,Licence URL',
		`50110,early,Early share,0.02,Share,Measured,line=51,2026-11-19; 2026-11-20,${tail}`,
		`50110,on_time,On-time share,0.97,Share,Measured,line=51,2026-11-19; 2026-11-20,${tail}`,
		`50110,median_delay,Median delay,-8,Seconds,Too few,line=51,2026-11-19; 2026-11-20,${tail}`,
		'',
	]);
});

it('keeps a quoted line break and doubled quotes inside a field', async () => {
	const csv = 'Notice,Text\r\n1,"Detour\r\nvia ""Main"", then back"\r\n2,Plain\r\n';
	expect(await text([csv])).toBe(
		'Notice,Text,Data source and licence,Licence URL\r\n' +
			`1,"Detour\r\nvia ""Main"", then back",${tail}\r\n2,Plain,${tail}\r\n`,
	);
});

it('reads records across chunk boundaries, even inside a CRLF or a quote', async () => {
	expect(await text(['Line,Na', 'me\r', '\n51,"Édouard', '-Montpetit"\r', '\n'])).toBe(
		`Line,Name,Data source and licence,Licence URL\r\n51,Édouard-Montpetit,${tail}\r\n`,
	);
});

it('ends the last row without a final line break, and writes nothing more for an empty file', async () => {
	expect(await text(['Measure\npunctuality'])).toBe(
		`Measure ID,Measure,Data source and licence,Licence URL\r\npunctuality,punctuality,${tail}\r\n`,
	);
	expect(await text([])).toBe('');
});

it('reads one value from any list or keyed cell, and leaves plain text alone', () => {
	expect(scalarCell('[12]')).toBe('12');
	expect(scalarCell('[]')).toBe('');
	expect(scalarCell('{"line": "51", "direction": 0}')).toBe('line=51; direction=0');
	expect(scalarCell('Detour [via Main]')).toBe('Detour [via Main]');
	expect(scalarCell('0.8')).toBe('0.8');
});
