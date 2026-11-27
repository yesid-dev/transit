import { beforeEach, expect, it, vi } from 'vitest';
import catalog from '../../../e2e/providers.json';
import { appendCsvColumn, recordCsvResponse } from './recordCsv.ts';
import { csvText } from '../../tests/csv.ts';
import { csvDataHref } from '#lib/utils/csvDownload.ts';

const engine = vi.hoisted(() => ({ getCityCatalog: vi.fn(), getRecordCsv: vi.fn() }));
vi.mock('./engine.ts', () => engine);

function download(lang: 'en' | 'fr' = 'en', options?: Parameters<typeof recordCsvResponse>[5]) {
	const url = new URL(
		'https://transit.yesid.dev/metrics/record.csv?provider=stm&recordFrom=2026-11-15&recordTo=2026-11-15',
	);
	return recordCsvResponse(
		{ path: '/measure', parameters: { measure: 'on_time' } },
		url,
		new Request(url),
		lang,
		'on_time.csv',
		options,
	);
}

beforeEach(() => {
	engine.getCityCatalog.mockReset().mockResolvedValue(catalog);
	engine.getRecordCsv.mockReset();
});

it.each([400, 404, 422])('preserves a permanent upstream CSV error (%i)', async (status) => {
	engine.getRecordCsv.mockResolvedValueOnce(new Response('invalid question', { status }));
	const response = await download();
	expect(response.status).toBe(status);
	expect(await response.text()).toContain('download');
});

it('preserves Retry-After on a busy CSV response', async () => {
	engine.getRecordCsv.mockResolvedValueOnce(
		new Response('busy', { status: 503, headers: { 'retry-after': '60' } }),
	);
	const response = await download();
	expect(response.status).toBe(503);
	expect(response.headers.get('retry-after')).toBe('60');
});

it('rejects invalid transformed dates before starting a CSV read', async () => {
	const response = await download('fr', {
		selectPeriod: () => ({ from: '2026-11-15', to: '2026-02-30' }),
	});
	expect(response.status).toBe(400);
	expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
	expect(await response.text()).toContain('Vérifiez la ville, les dates et la mesure.');
	expect(engine.getRecordCsv).not.toHaveBeenCalled();
});

it('answers a missing identity with a plain localized 404 before requesting CSV', async () => {
	const response = await download('fr', {
		identity: { code: 'LINE_NOT_FOUND', check: async () => 'missing' },
	});
	expect(response.status).toBe(404);
	expect(response.headers.get('content-disposition')).toBeNull();
	expect(await response.text()).toBe('Cette ligne est introuvable.\n');
	expect(engine.getRecordCsv).not.toHaveBeenCalled();
});

it('reports a transport outage as temporary and attaches the request cancellation signal', async () => {
	engine.getRecordCsv.mockRejectedValueOnce(new Error('engine unreachable'));
	const response = await download();
	expect(response.status).toBe(503);
	expect(await response.text()).toContain('temporarily unavailable');
	expect(engine.getRecordCsv).toHaveBeenCalledWith(
		expect.any(Object),
		expect.any(Object),
		'en',
		expect.any(AbortSignal),
	);
});

const source = {
	en: '"STM open data, computed by Transit"',
	fr: '"Données ouvertes de STM, calculs de Transit"',
};
it.each([
	['en', ['id\r1\r'], `id,Data source and licence\r1,${source.en}\r`],
	[
		'fr',
		['\ufeffid\r', '\n"Premier\nDeuxième"\r', '\n2'],
		`id,Source des données et licence\r\n"Premier\nDeuxième",${source.fr}\r\n2,${source.fr}`,
	],
] as const)(
	'attributes %s CSV once per record across stream boundaries',
	async (lang, chunks, expected) => {
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				controller.close();
			},
		});
		engine.getRecordCsv.mockResolvedValueOnce(
			new Response(body, { headers: { 'content-type': 'text/csv' } }),
		);
		const response = await download(lang);
		expect(response.headers.get('content-disposition')).toBe('attachment; filename="on_time.csv"');
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(csvText(new Uint8Array(await response.arrayBuffer()))).toBe(expected);
	},
);

async function transform(
	chunks: string[],
	header = 'Data source and licence',
	value = 'STM open data, CC BY 4.0, computed by Transit',
) {
	const encoder = new TextEncoder();
	const source = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
	const response = new Response(source.pipeThrough(appendCsvColumn(header, value)));
	return csvText(new Uint8Array(await response.arrayBuffer()));
}

const cell = '"STM open data, CC BY 4.0, computed by Transit"';

it('writes exactly one UTF-8 BOM when the source has none or splits one across chunks', async () => {
	expect(csvDataHref('Measure\n')).toBe('data:text/csv;charset=utf-8,%EF%BB%BFMeasure%0A');
	for (const chunks of [
		[new TextEncoder().encode('Measure\n')],
		[Uint8Array.of(0xef), Uint8Array.of(0xbb, 0xbf, ...new TextEncoder().encode('Measure\n'))],
	]) {
		const input = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk);
				controller.close();
			},
		});
		const response = new Response(input.pipeThrough(appendCsvColumn('Licence', 'CC BY')));
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(
			new TextEncoder().encode('\ufeffMeasure,Licence\n'),
		);
	}
});

it('adds the source column to the header and to every row', async () => {
	expect(await transform(['Measure,Value\npoll_success,2026-11-11\n'])).toBe(
		`Measure,Value,Data source and licence\npoll_success,2026-11-11,${cell}\n`,
	);
});

it('keeps a quoted line break inside a field and the file’s CRLF endings', async () => {
	const csv = 'Notice,Text\r\n1,"Detour\r\nvia ""Main"", then back"\r\n2,Plain\r\n';
	expect(await transform([csv])).toBe(
		`Notice,Text,Data source and licence\r\n1,"Detour\r\nvia ""Main"", then back",${cell}\r\n2,Plain,${cell}\r\n`,
	);
});

it('reads records across chunk boundaries, even inside a CRLF or a quote', async () => {
	expect(await transform(['Line,Na', 'me\r', '\n51,"Édouard', '-Montpetit"\r', '\n'])).toBe(
		`Line,Name,Data source and licence\r\n51,"Édouard-Montpetit",${cell}\r\n`,
	);
});

it('ends the last row even without a final line break, and adds nothing to an empty file', async () => {
	expect(await transform(['Measure\npunctuality'])).toBe(
		`Measure,Data source and licence\npunctuality,${cell}`,
	);
	expect(await transform([])).toBe('');
});
