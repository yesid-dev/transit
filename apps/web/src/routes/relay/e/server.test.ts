import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ PUBLIC_PLAUSIBLE_DOMAIN: 'transit.yesid.dev' }));
vi.mock('$app/env/public', () => env);
const { limit } = vi.hoisted(() => ({ limit: vi.fn() }));
vi.mock('cloudflare:workers', () => ({ env: { TELEMETRY_RATE_LIMITER: { limit } } }));
beforeEach(() => {
	limit.mockReset().mockResolvedValue({ success: true });
});

const { POST } = await import('./+server');

const pageview = {
	n: 'pageview',
	d: 'transit.yesid.dev',
	u: 'https://transit.yesid.dev/lines',
	r: null,
};

function call(body: unknown) {
	const request = new Request('https://transit.yesid.dev/relay/e', {
		method: 'POST',
		headers: { 'Content-Type': 'text/plain', 'User-Agent': 'Agent/1.0' },
		body: JSON.stringify(body),
	});
	return POST({ request, getClientAddress: () => '203.0.113.7' } as Parameters<typeof POST>[0]);
}

afterEach(() => {
	vi.unstubAllGlobals();
	env.PUBLIC_PLAUSIBLE_DOMAIN = 'transit.yesid.dev';
});

describe('POST /relay/e', () => {
	it('forwards a Transit pageview to Plausible once, with the visitor address', async () => {
		const upstream = vi.fn(async () => new Response('ok', { status: 202 }));
		vi.stubGlobal('fetch', upstream);

		const response = await call(pageview);

		expect(response.status).toBe(202);
		expect(upstream).toHaveBeenCalledOnce();
		const [url, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('https://plausible.io/api/event');
		expect(init.headers).toMatchObject({
			'X-Forwarded-For': '203.0.113.7',
			'User-Agent': 'Agent/1.0',
		});
	});

	it('answers 502 without a retry when Plausible fails', async () => {
		const upstream = vi.fn(async () => new Response('', { status: 500 }));
		vi.stubGlobal('fetch', upstream);

		expect((await call(pageview)).status).toBe(502);
		expect(upstream).toHaveBeenCalledOnce();
	});

	it('refuses an event for the parent yesid.dev site, so a visit is never counted under both', async () => {
		const upstream = vi.fn();
		vi.stubGlobal('fetch', upstream);

		expect((await call({ ...pageview, d: 'yesid.dev' })).status).toBe(400);
		expect(upstream).not.toHaveBeenCalled();
	});

	it('is absent where measurement is off', async () => {
		env.PUBLIC_PLAUSIBLE_DOMAIN = '';
		const upstream = vi.fn();
		vi.stubGlobal('fetch', upstream);

		expect((await call(pageview)).status).toBe(404);
		expect(upstream).not.toHaveBeenCalled();
	});

	it('forwards only the approved event fields, dimensions and URL data', async () => {
		const upstream = vi.fn(async () => new Response('', { status: 202 }));
		vi.stubGlobal('fetch', upstream);
		const response = await call({
			...pageview,
			n: 'Search Result',
			u: pageview.u + '?q=search&provider=stm&utm_source=notice#selection',
			r: 'https://referrer.example/path?q=search',
			extra: 'ignored',
			p: { locale: 'fr', provider: 'stm', kind: 'route', placement: 'page', search: 'ignored' },
		});
		expect(response.status).toBe(202);
		const [, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
		expect(JSON.parse(init.body as string)).toEqual({
			n: 'Search Result',
			d: pageview.d,
			u: pageview.u + '?utm_source=notice',
			r: 'https://referrer.example/',
			p: { locale: 'fr', provider: 'stm', kind: 'route' },
		});
	});

	it('refuses unsupported event names and off-site page URLs', async () => {
		const upstream = vi.fn();
		vi.stubGlobal('fetch', upstream);
		expect((await call({ ...pageview, n: 'unexpected event' })).status).toBe(400);
		expect((await call({ ...pageview, u: 'https://example.test/' })).status).toBe(400);
		expect(upstream).not.toHaveBeenCalled();
	});

	it('applies the rate budget before forwarding an event', async () => {
		limit.mockResolvedValueOnce({ success: false });
		const upstream = vi.fn();
		vi.stubGlobal('fetch', upstream);
		const response = await call(pageview);
		expect(response.status).toBe(429);
		expect(response.headers.get('retry-after')).toBe('60');
		expect(limit).toHaveBeenCalledWith({ key: 'relay:203.0.113.7' });
		expect(upstream).not.toHaveBeenCalled();
	});
});
