import { beforeEach, expect, it, vi } from 'vitest';
import catalog from '../../../e2e/providers.json';
import { csvFilename, recordCsvResponse } from './recordCsv.ts';
import { csvText } from '../../tests/csv.ts';

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

it.each([
	['en', ['Measure,Value\r', '\non_time,0.8'], 'stm-on_time-2026-11-15-en.csv'],
	['fr', ['\ufeffMesure,Valeur\r\non_time,0', '.8\r\n'], 'stm-on_time-2026-11-15-fr.csv'],
] as const)(
	'writes a %s spreadsheet file with its network, dates and language in its name',
	async (lang, chunks, name) => {
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
		expect(response.headers.get('content-disposition')).toBe(`attachment; filename="${name}"`);
		expect(response.headers.get('cache-control')).toBe('no-store');
		const [header, row] = csvText(new Uint8Array(await response.arrayBuffer())).split('\r\n');
		expect(header).toBe(
			lang === 'fr'
				? 'Identifiant de la mesure,Mesure,Valeur,Source des données et licence,Adresse de la licence'
				: 'Measure ID,Measure,Value,Data source and licence,Licence URL',
		);
		expect(row).toMatch(
			lang === 'fr' ? /^on_time,Part à l’heure,0\.8,/u : /^on_time,On-time share,0\.8,/u,
		);
	},
);

it('names two downloads of different pages, dates or languages apart', () => {
	const week = { from: '2026-11-19', to: '2026-11-25' };
	expect(csvFilename('stm', 'line-51-punctuality.csv', week, 'en')).toBe(
		'stm-line-51-punctuality-2026-11-19-to-2026-11-25-en.csv',
	);
	expect(csvFilename('octranspo', 'line-5-punctuality.csv', week, 'fr')).toBe(
		'octranspo-line-5-punctuality-2026-11-19-to-2026-11-25-fr.csv',
	);
	expect(csvFilename('stm', 'stop-Côte/Vertu 2-delay.csv', week, 'en')).toBe(
		'stm-stop-Cote-Vertu-2-delay-2026-11-19-to-2026-11-25-en.csv',
	);
});
