import { afterEach, expect, it, vi } from 'vitest';

const workers = vi.hoisted(() => ({ env: {} as Record<string, unknown> }));
vi.mock('cloudflare:workers', () => workers);

afterEach(() => {
	for (const key of Object.keys(workers.env)) delete workers.env[key];
	vi.resetModules();
	vi.useRealTimers();
});

async function handler() {
	const { GET } = await import('./+server');
	return () => GET({} as Parameters<typeof GET>[0]);
}

it('reports an unconfigured proxy without reading snapshots', async () => {
	const get = vi.fn();
	workers.env.SNAPSHOTS = { get };
	const request = await handler();
	const response = await request();
	expect(response.status).toBe(503);
	expect(response.headers.get('cache-control')).toBe('no-store');
	expect(await response.json()).toMatchObject({
		status: 'unavailable',
		proxy: 'unconfigured',
		engine: 'unknown',
		service: 'transit1-web',
		commit: null,
		branch: null,
	});
	expect(get).not.toHaveBeenCalled();
});

it('shares the health probe and observes engine recovery after the failure memo', async () => {
	vi.useFakeTimers();
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(Response.json({ engine: 'unavailable' }, { status: 503 }))
		.mockResolvedValueOnce(Response.json({ engine: 'ok' }));
	workers.env.QUESTION_PROXY = { fetch };
	workers.env.TRANSIT_COMMIT_SHA = 'b5b283781a6fe6ab12c424dd685bbb854d515962';
	workers.env.TRANSIT_BRANCH = 'main';
	const request = await handler();
	const [first, second] = await Promise.all([request(), request()]);
	expect(first.status).toBe(503);
	expect(second.status).toBe(503);
	expect(await first.json()).toMatchObject({ proxy: 'ok', engine: 'unavailable' });
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(fetch.mock.calls[0][0].url).toBe('https://data.yesid.dev/v2/health');
	await vi.advanceTimersByTimeAsync(4_001);
	const recovered = await request();
	expect(recovered.status).toBe(200);
	expect(await recovered.json()).toMatchObject({
		status: 'ok',
		proxy: 'ok',
		engine: 'ok',
		commit: workers.env.TRANSIT_COMMIT_SHA,
		branch: 'main',
	});
	expect((await request()).status).toBe(200);
	expect(fetch).toHaveBeenCalledTimes(2);
});

it.each([
	() => Promise.reject(new Error('private error')),
	() => Promise.resolve(Response.json({})),
])('treats a broken or unexpected proxy response as an unknown engine state', async (fetch) => {
	workers.env.QUESTION_PROXY = { fetch };
	const request = await handler();
	const response = await request();
	expect(response.status).toBe(503);
	expect(await response.json()).toMatchObject({ proxy: 'unavailable', engine: 'unknown' });
});
