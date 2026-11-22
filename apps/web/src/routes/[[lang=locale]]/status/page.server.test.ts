import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
	ctx: { fetch: vi.fn(), providerId: 'octranspo', manifest: { provider: 'octranspo' } },
	getProvenance: vi.fn(),
	getDataHealth: vi.fn(),
	getHistoricAvailability: vi.fn(),
	serverV1Context: vi.fn(),
	engineFetch: vi.fn<(request: Request) => Promise<Response>>(),
}));

vi.mock('cloudflare:workers', () => ({ env: { QUESTION_PROXY: { fetch: harness.engineFetch } } }));

vi.mock('#lib/v1/repositories/provenance.ts', () => ({
	getProvenance: (...args: unknown[]) => harness.getProvenance(...args),
}));

vi.mock('#lib/v1/repositories/dataHealth.ts', () => ({
	getDataHealth: (...args: unknown[]) => harness.getDataHealth(...args),
}));

vi.mock('#lib/v1/repositories/historic.ts', () => ({
	getHistoricAvailability: (...args: unknown[]) => harness.getHistoricAvailability(...args),
}));

vi.mock('#lib/v1/serverContext.ts', () => ({
	serverV1Context: (...args: unknown[]) => harness.serverV1Context(...args),
}));

import { load } from './+page.server';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function event(path = '/status?frameMode=live'): Parameters<typeof load>[0] {
	const url = new URL(path, 'https://transit1.yesid.dev');
	return {
		params: { lang: undefined },
		url,
		request: new Request(url, { headers: { 'cf-connecting-ip': '192.0.2.11' } }),
		fetch: vi.fn(),
		locals: { v1Cache: new Map() },
		platform: undefined,
		parent: async () => ({ v1: { manifest: harness.ctx.manifest }, providerId: 'octranspo' }),
	} as unknown as Parameters<typeof load>[0];
}

beforeEach(() => {
	harness.getProvenance.mockReset();
	harness.getDataHealth.mockReset();
	harness.getHistoricAvailability.mockReset();
	harness.serverV1Context.mockReset().mockReturnValue(harness.ctx);
	harness.engineFetch.mockReset();
});

describe('/status server seeds', () => {
	it('starts all honesty reads concurrently through one request context', async () => {
		const provenance = { generated_utc: '2026-07-14T12:00:00Z', freshness: [] };
		const dataHealth = { generated_utc: '2026-07-14T12:00:00Z', lanes: [] };
		const history = { generated_utc: '2026-07-14T12:00:00Z', families: [] };
		const provenanceRead = deferred<typeof provenance>();
		const dataHealthRead = deferred<typeof dataHealth>();
		const historyRead = deferred<typeof history>();
		harness.getProvenance.mockReturnValue(provenanceRead.promise);
		harness.getDataHealth.mockReturnValue(dataHealthRead.promise);
		harness.getHistoricAvailability.mockReturnValue(historyRead.promise);

		const pending = load(event());
		await Promise.resolve();

		expect(harness.serverV1Context).toHaveBeenCalledTimes(1);
		expect(harness.getProvenance).toHaveBeenCalledWith(harness.ctx);
		expect(harness.getDataHealth).toHaveBeenCalledWith(harness.ctx);
		expect(harness.getHistoricAvailability).toHaveBeenCalledWith(harness.ctx);

		provenanceRead.resolve(provenance);
		dataHealthRead.resolve(dataHealth);
		historyRead.resolve(history);

		await expect(pending).resolves.toEqual({
			view: 'live',
			provenanceSeed: { key: 'provenance', data: provenance },
			dataHealthSeed: { key: 'data-health', data: dataHealth },
			historicAvailabilitySeed: { key: 'historic-availability', data: history },
		});
	});

	it('keeps successful seeds when one independent honesty read fails', async () => {
		const provenance = { generated_utc: '2026-07-14T12:00:00Z', freshness: [] };
		const history = { generated_utc: '2026-07-14T12:00:00Z', families: [] };
		harness.getProvenance.mockResolvedValue(provenance);
		harness.getDataHealth.mockRejectedValue(new Error('live tier unavailable'));
		harness.getHistoricAvailability.mockResolvedValue(history);

		await expect(load(event())).resolves.toEqual({
			view: 'live',
			provenanceSeed: { key: 'provenance', data: provenance },
			dataHealthSeed: null,
			historicAvailabilitySeed: { key: 'historic-availability', data: history },
		});
	});
});

it('streams day coverage and current methods from independent engine requests in Record', async () => {
	const health = deferred<Response>();
	harness.engineFetch.mockReturnValueOnce(health.promise).mockResolvedValueOnce(Response.json([]));
	const data = await load(event('/fr/status?recordFrom=2026-11-11&recordTo=2026-11-14'));
	expect(data?.view).toBe('record');
	if (data?.view !== 'record' || !data.record) throw new Error('Expected a record period');
	expect(harness.engineFetch.mock.calls.map(([request]) => request.url)).toEqual([
		'https://data.yesid.dev/v2/octranspo/data-health?from=2026-11-11&to=2026-11-14',
		'https://data.yesid.dev/v2/how-we-measure',
	]);
	expect(harness.engineFetch.mock.calls[0]?.[0].headers.get('x-transit-visitor-ip')).toBe(
		'192.0.2.11',
	);
	expect(harness.getDataHealth).not.toHaveBeenCalled();
	await expect(data.record.methods).resolves.toEqual({ kind: 'answer', answer: [] });
	health.resolve(new Response(null, { status: 503, headers: { 'retry-after': '30' } }));
	await expect(data.record.health).resolves.toEqual({ kind: 'busy' });
});
