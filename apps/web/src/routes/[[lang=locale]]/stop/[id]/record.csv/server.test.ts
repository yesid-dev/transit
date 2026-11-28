import { beforeEach, expect, it, vi } from 'vitest';
import catalog from '../../../../../../e2e/providers.json';
import { GET } from './+server';

const engine = vi.hoisted(() => ({
	getCityCatalog: vi.fn(),
	getRecordCsv: vi.fn(),
	getRecordAnswer: vi.fn(),
	getScheduleEdition: vi.fn(),
	getCachedVehicleIndex: vi.fn(),
}));
vi.mock('#lib/server/engine.ts', () => engine);

const schedule = { date: '2026-11-25', routes: [], stops: [{ id: 'S1', name: 'Stop one' }] };
const archive = (ids: string[]) => ({
	kind: 'answer',
	answer: {
		cells: ids.map((stop) => ({ key: { stop } })),
		evidence: { days_included: ['2026-11-24'] },
	},
});

function download(id: string, lang?: 'fr') {
	const url = new URL(
		`https://transit.yesid.dev/${lang ? 'fr/' : ''}stop/${id}/record.csv?provider=stm&section=punctuality&recordFrom=2026-11-19&recordTo=2026-11-25`,
	);
	return GET({
		params: { id, lang },
		url,
		request: new Request(url),
	} as never) as Promise<Response>;
}

beforeEach(() => {
	engine.getCityCatalog.mockReset().mockResolvedValue(catalog);
	engine.getScheduleEdition.mockReset().mockResolvedValue(schedule);
	engine.getRecordAnswer.mockReset().mockResolvedValue(archive([]));
	engine.getRecordCsv.mockReset().mockResolvedValue(
		new Response('Measure,Value\r\non_time,0.8\r\n', {
			status: 200,
			headers: { 'content-type': 'text/csv; charset=utf-8' },
		}),
	);
});

it.each([
	['en', 'This stop could not be found. Find it in the list of stops and download again.\n'],
	[
		'fr',
		'Cet arrêt est introuvable. Cherchez-le dans la liste des arrêts, puis téléchargez de nouveau le fichier.\n',
	],
] as const)('answers an unknown stop with a %s 404 and no file', async (lang, message) => {
	const response = await download('999999', lang === 'fr' ? 'fr' : undefined);
	expect(response.status).toBe(404);
	expect(response.headers.get('content-disposition')).toBeNull();
	expect(await response.text()).toBe(message);
	expect(engine.getRecordCsv).not.toHaveBeenCalled();
});

it('downloads a stop in the current timetable without asking the archive', async () => {
	const response = await download('S1');
	expect(response.status).toBe(200);
	expect(engine.getRecordAnswer).not.toHaveBeenCalled();
	expect(engine.getRecordCsv).toHaveBeenCalledOnce();
});

it('keeps a historical stop the Record still holds', async () => {
	engine.getRecordAnswer.mockResolvedValueOnce(archive(['OLD1']));
	const response = await download('OLD1');
	expect(response.status).toBe(200);
	expect(engine.getRecordCsv).toHaveBeenCalledOnce();
});

it('says the stop is temporarily unavailable when the lookup fails', async () => {
	engine.getRecordAnswer.mockResolvedValueOnce({ kind: 'unreachable' });
	const response = await download('OLD1');
	expect(response.status).toBe(503);
	expect(engine.getRecordCsv).not.toHaveBeenCalled();
});
