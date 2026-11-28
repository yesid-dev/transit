import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGunzip, gunzipSync } from 'node:zlib';
import { Duplex } from 'node:stream';
import { delocalizePath } from '#lib/i18n/routing.ts';
import { handle, handleError } from '../hooks.server';
import { getRequestEvent } from '$app/server';
import { timeQuestion } from '#lib/server/questionTiming.ts';

const workers = vi.hoisted(() => ({ waitUntil: vi.fn() }));
vi.mock('cloudflare:workers', () => workers);

const publicEnv = vi.hoisted(() => ({ PUBLIC_INDEXING: 'true' }));
vi.mock('$app/env/public', async () => ({
	...(await import('./publicEnv.ts')).PUBLIC_ENV,
	get PUBLIC_INDEXING() {
		return publicEnv.PUBLIC_INDEXING;
	},
}));
afterEach(() => {
	vi.restoreAllMocks();
	publicEnv.PUBLIC_INDEXING = 'true';
	vi.unstubAllGlobals();
});

it('logs unexpected server failures without personal request or error details', () => {
	const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
	handleError({
		kind: 'unknown',
		error: new Error('address=123 private street'),
		event: {
			...event('https://transit.yesid.dev/api/geocode?q=123+private+street'),
			route: { id: '/api/geocode' },
		},
	});
	expect(log.mock.calls).toEqual([[{ event: 'server_error', route: '/api/geocode' }]]);
});

it('keeps expected client errors quiet but reports deliberate server failures', () => {
	const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
	const requestEvent: Parameters<typeof handle>[0]['event'] = {
		...event(),
		route: { id: '/[[lang=locale]]' },
	};
	handleError({
		kind: 'framework',
		error: { status: 404, message: 'Not found' },
		event: requestEvent,
	});
	handleError({ kind: 'app', error: { status: 400, message: 'Bad request' }, event: requestEvent });
	expect(log).not.toHaveBeenCalled();
	handleError({
		kind: 'app',
		error: { status: 503, message: 'private detail' },
		event: requestEvent,
	});
	expect(log.mock.calls).toEqual([[{ event: 'server_error', route: '/[[lang=locale]]' }]]);
});

interface CacheHarness {
	readonly defaultMatch: ReturnType<typeof vi.fn>;
	readonly defaultPut: ReturnType<typeof vi.fn>;
	readonly match: ReturnType<typeof vi.fn>;
	readonly put: ReturnType<typeof vi.fn>;
	readonly open: ReturnType<typeof vi.fn>;
	readonly waitUntil: ReturnType<typeof vi.fn<(promise: Promise<unknown>) => void>>;
	readonly writes: Promise<unknown>[];
}

function cacheHarness(hit?: Response): CacheHarness {
	const writes: Promise<unknown>[] = [];
	const match = vi.fn(async () => hit);
	const put = vi.fn(async () => undefined);
	const defaultMatch = vi.fn();
	const defaultPut = vi.fn();
	return {
		defaultMatch,
		defaultPut,
		match,
		put,
		open: vi.fn(async () => ({ match, put })),
		waitUntil: vi.fn((promise: Promise<unknown>) => {
			writes.push(promise);
		}),
		writes,
	};
}

function event(
	url = 'https://transit.yesid.dev/',
	options: {
		readonly method?: string;
		readonly headers?: HeadersInit;
		readonly cache?: CacheHarness;
		readonly cf?: unknown;
		readonly routeId?: string;
	} = {},
): Parameters<typeof handle>[0]['event'] {
	const cache = options.cache;
	vi.stubGlobal(
		'caches',
		cache
			? { default: { match: cache.defaultMatch, put: cache.defaultPut }, open: cache.open }
			: undefined,
	);
	workers.waitUntil.mockImplementation((promise: Promise<unknown>) => {
		cache?.waitUntil(promise);
	});
	const request = new Request(url, {
		method: options.method ?? 'GET',
		headers: options.headers,
	});
	Object.defineProperty(request, 'cf', { value: options.cf });
	const requestUrl = new URL(url);
	const path = delocalizePath(requestUrl.pathname);
	return {
		url: requestUrl,
		request,
		locals: {},
		route: { id: options.routeId ?? `/[[lang=locale]]${path === '/' ? '' : path}` },
	} as Parameters<typeof handle>[0]['event'];
}

function html(body = 'fresh', init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set('content-type', 'text/html; charset=utf-8');
	return new Response(body, { ...init, headers });
}

const KIT_CSP = "script-src 'self' 'sha256-kit'";

describe('server request locale', () => {
	it('sets the non-indexing header only when public indexing is off', async () => {
		for (const indexing of [false, true]) {
			publicEnv.PUBLIC_INDEXING = String(indexing);
			const response = await handle({
				event: event(),
				resolve: vi.fn(async () => html()),
			});
			expect(response.headers.get('x-robots-tag')).toBe(indexing ? null : 'noindex, nofollow');
		}
	});

	it('never lets a workers.dev version or preview URL be indexed', async () => {
		const response = await handle({
			event: event('https://pr-7-transit-web.example.workers.dev/'),
			resolve: vi.fn(async () => html()),
		});
		expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
	});

	it('stores the path locale for error layouts that have no route params', async () => {
		const request = event('https://transit.yesid.dev/fr/missing-route');
		const resolve = vi.fn(async () => new Response('ok'));

		await handle({ event: request, resolve });

		expect(request.locals.locale).toBe('fr');
	});

	it('preloads JavaScript, CSS and only the latin fonts while preserving the locale transform', async () => {
		const request = event('https://transit.yesid.dev/fr/status');
		const resolve = vi.fn(async (_event, options) => {
			expect(options?.preload?.({ type: 'css', path: '/_app/app.css' })).toBe(true);
			const font = (name: string) =>
				options?.preload?.({ type: 'font', path: `/_app/immutable/assets/${name}.woff2` });
			expect(font('inter-latin-wght-normal.Dk3f9a')).toBe(true);
			expect(font('jetbrains-mono-latin-wght-normal.Dk3f9a')).toBe(true);
			expect(font('inter-latin-ext-wght-normal.Dk3f9a')).toBe(false);
			expect(options?.preload?.({ type: 'asset', path: '/brand.svg' })).toBe(true);
			expect(options?.preload?.({ type: 'js', path: '/_app/start.js' })).toBe(true);
			const transformed = options?.transformPageChunk?.({
				html: '<html lang="%lang%">status</html>',
				done: true,
			});
			return html(transformed);
		});

		const response = await handle({ event: request, resolve });

		expect(await response.text()).toBe('<html lang="fr">status</html>');
	});
});

describe('server HTML edge cache', () => {
	it.each(['/sitemap.xml', '/api/stops/slim'])(
		'preserves %s caching when location is irrelevant',
		async (path) => {
			const cacheControl = 'public, max-age=300, s-maxage=3600';
			const response = await handle({
				event: event(`https://transit.yesid.dev${path}`, {
					routeId: path,
					cf: { latitude: '45.42', longitude: '-75.70' },
				}),
				resolve: vi.fn(
					async () =>
						new Response('data', {
							headers: { 'content-type': 'application/json', 'cache-control': cacheControl },
						}),
				),
			});
			expect(response.headers.get('cache-control')).toBe(cacheControl);
		},
	);

	it.each([
		['Ottawa', { latitude: '45.42', longitude: '-75.70' }],
		['Montréal', { latitude: '45.50', longitude: '-73.60' }],
		['outside the supported areas', { latitude: '43.65', longitude: '-79.38' }],
	])('does not reuse or store location-dependent HTML for %s', async (_city, cf) => {
		const cache = cacheHarness(html('cached for another city'));
		const request = event('https://transit.yesid.dev/fr/network', { cache, cf });
		const resolve = vi.fn(async () => html('selected for this visitor'));
		const response = await handle({ event: request, resolve });
		expect(await response.text()).toBe('selected for this visitor');
		expect(resolve).toHaveBeenCalledOnce();
		expect(cache.match).not.toHaveBeenCalled();
		expect(cache.put).not.toHaveBeenCalled();
		expect(response.headers.get('cache-control')).toBe('no-store');
	});

	it('keeps explicit network pages cacheable regardless of visitor location', async () => {
		const cache = cacheHarness(html('Montréal'));
		const request = event('https://transit.yesid.dev/network?provider=stm', {
			cache,
			cf: { latitude: '45.42', longitude: '-75.70' },
		});
		const resolve = vi.fn(async () => html('Ottawa'));
		const response = await handle({ event: request, resolve });
		expect(await response.text()).toBe('Montréal');
		expect(resolve).not.toHaveBeenCalled();
		expect(response.headers.get('x-transit-edge-cache')).toBe('HIT');
	});

	it('keeps automatic redirects private even when the edge cache is unavailable', async () => {
		const response = await handle({
			event: event('https://transit.yesid.dev/fr/', {
				cf: { latitude: '45.42', longitude: '-75.70' },
			}),
			resolve: vi.fn(
				async () =>
					new Response(null, {
						status: 307,
						headers: { location: '/fr/?provider=octranspo' },
					}),
			),
		});
		expect(response.status).toBe(307);
		expect(response.headers.get('cache-control')).toBe('no-store');
	});

	it('keeps location-dependent page data private and passes the location to the layout', async () => {
		const request = {
			...event('https://transit.yesid.dev/fr/network', {
				cf: { latitude: '45.42', longitude: '-75.70' },
			}),
			isDataRequest: true,
		};
		const response = await handle({
			event: request,
			resolve: vi.fn(async (event) => {
				expect(event.locals.approximateLocation).toEqual({ lat: 45.42, lon: -75.7 });
				return new Response('{}', { headers: { 'content-type': 'application/json' } });
			}),
		});
		expect(response.headers.get('cache-control')).toBe('no-store');
	});

	it('serves an exact-URL cache hit without invoking SvelteKit, keeping its CSP and reapplying security headers', async () => {
		const cache = cacheHarness(html('cached', { headers: { 'content-security-policy': KIT_CSP } }));
		const request = event('https://transit.yesid.dev/fr/metrics/archive?grain=week', { cache });
		const resolve = vi.fn(async () => html('fresh'));

		const response = await handle({ event: request, resolve });

		expect(await response.text()).toBe('cached');
		expect(cache.open).toHaveBeenCalledWith('transit-html-v1');
		expect(cache.defaultMatch).not.toHaveBeenCalled();
		expect(cache.defaultPut).not.toHaveBeenCalled();
		expect(resolve).not.toHaveBeenCalled();
		expect(cache.match).toHaveBeenCalledTimes(1);
		const key = cache.match.mock.calls[0]?.[0] as Request;
		expect(key.method).toBe('GET');
		expect(key.url).toBe('https://transit.yesid.dev/fr/metrics/archive?grain=week');
		expect(response.headers.get('x-transit-edge-cache')).toBe('HIT');
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('content-security-policy')).toBe(KIT_CSP);
		expect(response.headers.get('x-content-type-options')).toBeTruthy();
		expect(cache.put).not.toHaveBeenCalled();
	});

	it('bypasses cached HTML for a server-data request with the same normalized URL', async () => {
		const cache = cacheHarness(html('<h1>cached document</h1>'));
		const request = {
			...event('https://transit.yesid.dev/fr/metrics/archive/__data.json', { cache }),
			url: new URL('https://transit.yesid.dev/fr/metrics/archive'),
			isDataRequest: true,
		};
		const payload = { type: 'data', nodes: [] };
		const resolve = vi.fn(
			async () =>
				new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } }),
		);

		const response = await handle({ event: request, resolve });

		expect(resolve).toHaveBeenCalledOnce();
		expect(cache.match).not.toHaveBeenCalled();
		expect(cache.put).not.toHaveBeenCalled();
		expect(request.locals.locale).toBe('fr');
		expect(response.headers.get('x-transit-edge-cache')).toBe('BYPASS');
		expect(response.headers.get('content-type')).toBe('application/json');
		expect(response.headers.get('link')).toBeNull();
		expect(await response.json()).toEqual(payload);
	});

	it('stores a safe anonymous HTML miss for 30 seconds without exposing that TTL publicly', async () => {
		const cache = cacheHarness();
		const request = event('https://transit.yesid.dev/lines/24?tab=detail', { cache });
		const resolve = vi.fn(async () =>
			html('fresh', { headers: { 'content-security-policy': KIT_CSP } }),
		);

		const response = await handle({ event: request, resolve });
		await Promise.all(cache.writes);

		expect(await response.text()).toBe('fresh');
		expect(response.headers.get('x-transit-edge-cache')).toBe('MISS');
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(cache.put).toHaveBeenCalledTimes(1);
		expect(cache.waitUntil).toHaveBeenCalledTimes(1);
		const [key, stored] = cache.put.mock.calls[0] as [Request, Response];
		expect(key.url).toBe('https://transit.yesid.dev/lines/24?tab=detail');
		expect(key.method).toBe('GET');
		expect(stored.headers.get('content-security-policy')).toBe(KIT_CSP);
		expect(stored.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=30');
		expect(stored.headers.get('x-transit-edge-cache')).toBeNull();
	});

	it('says how the page asked its questions, but not in the copy kept for later requests', async () => {
		const cache = cacheHarness();
		const request = event('https://transit.yesid.dev/lines/24?tab=detail', { cache });
		// Load functions see their own copy of the event, with the same request.
		vi.mocked(getRequestEvent).mockReturnValue({ ...request } as ReturnType<
			typeof getRequestEvent
		>);
		try {
			const resolve = vi.fn(async () => {
				timeQuestion('punctuality')(
					new Headers({ 'server-timing': 'src;desc=engine, cache;desc=miss, engine;dur=40' }),
				);
				return html('fresh', { headers: { 'content-security-policy': KIT_CSP } });
			});

			const response = await handle({ event: request, resolve });
			await Promise.all(cache.writes);

			expect(response.headers.get('server-timing')).toMatch(
				/^questions;desc="answered 1 \(engine 1\), waiting 0", engine;dur=40\.0, /,
			);
			const [, stored] = cache.put.mock.calls[0] as [Request, Response];
			expect(stored.headers.get('server-timing')).toBeNull();
		} finally {
			vi.mocked(getRequestEvent).mockReset();
			vi.mocked(getRequestEvent).mockImplementation(() => {
				throw new Error('No page is being served');
			});
		}
	});

	it.each([
		['cookie', { cookie: 'session=private' }],
		['authorization', { authorization: 'Bearer private' }],
		['range', { range: 'bytes=0-99' }],
		['request no-cache', { 'cache-control': 'no-cache' }],
		['request no-store', { 'cache-control': 'no-store' }],
	])('bypasses both cache reads and writes for %s requests', async (_label, headers) => {
		const cache = cacheHarness(html('cached'));
		const request = event('https://transit.yesid.dev/metrics/archive', { cache, headers });
		const resolve = vi.fn(async () => html('fresh'));

		const response = await handle({ event: request, resolve });

		expect(await response.text()).toBe('fresh');
		expect(resolve).toHaveBeenCalledTimes(1);
		expect(cache.match).not.toHaveBeenCalled();
		expect(cache.put).not.toHaveBeenCalled();
		expect(response.headers.get('x-transit-edge-cache')).toBe('BYPASS');
	});

	it.each([
		['POST', html()],
		['GET', html('not found', { status: 404 })],
		['GET', new Response('{}', { headers: { 'content-type': 'application/json' } })],
		['GET', html('private', { headers: { 'cache-control': 'private, no-store' } })],
		['GET', html('cookie', { headers: { 'set-cookie': 'session=secret' } })],
	] as const)('does not store an unsafe %s response variant', async (method, resolved) => {
		const cache = cacheHarness();
		const request = event('https://transit.yesid.dev/metrics/archive', { cache, method });

		await handle({ event: request, resolve: vi.fn(async () => resolved) });

		expect(cache.put).not.toHaveBeenCalled();
	});

	it('keeps a document with a CSP nonce out of both downstream and edge caches', async () => {
		const cache = cacheHarness();
		const request = event('https://transit.yesid.dev/metrics/archive', { cache });
		const resolve = vi.fn(async () =>
			html('streamed', {
				headers: { 'content-security-policy': "script-src 'self' 'nonce-test'" },
			}),
		);

		const response = await handle({ event: request, resolve });
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(cache.put).not.toHaveBeenCalled();
	});

	it.each([
		['https://transit.yesid.dev/fr?provider=stm', '/[[lang=locale]]'],
		['https://transit1.yesid.dev/lines/24', '/[[lang=locale]]/lines/[id]'],
		['http://127.0.0.1:4317/lines/24', '/[[lang=locale]]/lines/[id]'],
		['http://127.0.0.1:4317/fr/lines/24?frameMode=record', '/[[lang=locale]]/lines/[id]'],
		['https://transit1.yesid.dev/fr/lines/24?tab=schedule', '/[[lang=locale]]/lines/[id]'],
		['http://127.0.0.1:4317/lines/24?frameMode=live', '/[[lang=locale]]/lines/[id]'],
		['https://transit1.yesid.dev/lines/24?tab=detail', '/[[lang=locale]]/lines/[id]'],
		[
			'https://transit1.yesid.dev/lines/24?frameMode=live&tab=detail',
			'/[[lang=locale]]/lines/[id]',
		],
		[
			'https://transit1.yesid.dev/fr/stop/S1?frameMode=record#waiting',
			'/[[lang=locale]]/stop/[id]',
		],
		['https://transit1.yesid.dev/lines/24?frameMode=record#offered', '/[[lang=locale]]/lines/[id]'],
		['https://transit1.yesid.dev/rankings?kind=stop', '/[[lang=locale]]/rankings'],
		['https://transit1.yesid.dev/fr/rankings?kind=vehicle', '/[[lang=locale]]/rankings'],
		['https://transit1.yesid.dev/fr/metrics', '/[[lang=locale]]/metrics'],
		['https://transit1.yesid.dev/status', '/[[lang=locale]]/status'],
		['https://transit1.yesid.dev/lines', '/[[lang=locale]]/lines'],
		['http://127.0.0.1:4317/fr/stops?frameMode=record', '/[[lang=locale]]/stops'],
		['https://transit1.yesid.dev/fr/receipt', '/[[lang=locale]]/receipt'],
		['https://transit1.yesid.dev/departure/key', '/[[lang=locale]]/departure/[key]'],
	])('delivers the identity variant without caching for %s', async (url, routeId) => {
		const cache = cacheHarness(html('cached'));
		const request = event(url, { cache, routeId });
		const response = await handle({ event: request, resolve: vi.fn(async () => html('streamed')) });

		expect(await response.text()).toBe('streamed');
		expect(response.headers.get('content-encoding')).toBe('identity');
		expect(response.headers.get('vary')).toBe('Accept-Encoding');
		expect(response.headers.get('cache-control')).toBe('no-store, no-transform');
		expect(cache.match).not.toHaveBeenCalled();
		expect(cache.put).not.toHaveBeenCalled();
	});

	it.each([
		['GZip; q=0.5', undefined, 'gzip'],
		['*;q=0.5', undefined, 'gzip'],
		['gzip;q=0, *;q=1', undefined, 'identity'],
		['gzip;q=0.5, identity;q=1', undefined, 'identity'],
		['br, gzip', 'deflate', 'identity'],
		['br, gzip', '', 'identity'],
	])(
		'negotiates %s with original client encoding %s',
		async (header, clientAcceptEncoding, encoding) => {
			const request = event('https://transit1.yesid.dev/stops', {
				routeId: '/[[lang=locale]]/stops',
				headers: { 'accept-encoding': header },
				cf: { clientAcceptEncoding },
			});
			const response = await handle({
				event: request,
				resolve: vi.fn(async () =>
					html('streamed', {
						headers: { vary: 'Origin', 'content-length': '8' },
					}),
				),
			});
			expect(response.headers.get('content-encoding')).toBe(encoding);
			expect(response.headers.get('vary')).toBe('Origin, Accept-Encoding');
			expect(response.headers.get('cache-control')).toBe('no-store, no-transform');
			if (encoding === 'gzip') {
				expect(response.headers.get('content-length')).toBeNull();
				expect(gunzipSync(new Uint8Array(await response.arrayBuffer())).toString()).toBe(
					'streamed',
				);
			} else {
				expect(await response.text()).toBe('streamed');
			}
		},
	);

	it('delivers each gzip chunk while the next section is still pending', async () => {
		const request = event('https://transit1.yesid.dev/stops', {
			routeId: '/[[lang=locale]]/stops',
			headers: { 'accept-encoding': 'gzip' },
		});
		const source = new TransformStream<Uint8Array, Uint8Array>();
		const response = await handle({
			event: request,
			resolve: vi.fn(
				async () =>
					new Response(source.readable, {
						headers: { 'content-type': 'text/html' },
					}),
			),
		});
		expect(response.headers.get('content-encoding')).toBe('gzip');
		const writer = source.writable.getWriter();
		const reader = response.body!.pipeThrough<Uint8Array>(Duplex.toWeb(createGunzip())).getReader();
		const encoder = new TextEncoder();
		const decoder = new TextDecoder();
		try {
			for (const text of ['shell', 'finished section', 'slow section']) {
				await writer.write(encoder.encode(text));
				let decoded = '';
				while (decoded.length < text.length) {
					const { done, value } = await reader.read();
					expect(done).toBe(false);
					decoded += decoder.decode(value);
				}
				expect(decoded).toBe(text);
			}
			await writer.close();
			expect((await reader.read()).done).toBe(true);
		} finally {
			await reader.cancel();
		}
	});

	it.each([
		['HEAD', 200, 'identity'],
		['GET', 307, null],
		['GET', 500, null],
	])('keeps %s status %s outside compression', async (method, status, encoding) => {
		const response = await handle({
			event: event('https://transit1.yesid.dev/stops', {
				routeId: '/[[lang=locale]]/stops',
				method,
				headers: { 'accept-encoding': 'gzip' },
			}),
			resolve: vi.fn(async () => html('original', { status })),
		});
		expect(response.status).toBe(status);
		expect(response.headers.get('content-encoding')).toBe(encoding);
		expect(await response.text()).toBe(method === 'HEAD' ? '' : 'original');
	});

	it('uses a cached GET representation for HEAD without returning a body', async () => {
		const cache = cacheHarness(html('cached'));
		const request = event('https://transit.yesid.dev/metrics/archive', { cache, method: 'HEAD' });
		const resolve = vi.fn(async () => html('fresh'));

		const response = await handle({ event: request, resolve });

		expect(resolve).not.toHaveBeenCalled();
		expect(await response.text()).toBe('');
		expect(response.headers.get('content-type')).toContain('text/html');
		expect(response.headers.get('x-transit-edge-cache')).toBe('HIT');
	});

	it('fails open when cache reads or writes reject', async () => {
		const readFailure = cacheHarness();
		readFailure.match.mockRejectedValueOnce(new Error('cache read unavailable'));
		readFailure.put.mockRejectedValueOnce(new Error('cache write unavailable'));
		const resolve = vi.fn(async () => html('fresh'));

		const response = await handle({
			event: event('https://transit.yesid.dev/metrics/archive', { cache: readFailure }),
			resolve,
		});
		await expect(Promise.all(readFailure.writes)).resolves.toBeDefined();

		expect(await response.text()).toBe('fresh');
		expect(resolve).toHaveBeenCalledTimes(1);
	});
});
