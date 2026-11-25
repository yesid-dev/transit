import { waitUntil } from 'cloudflare:workers';
import { Duplex } from 'node:stream';
import { constants, createGzip } from 'node:zlib';
import type { Handle, HandleServerError, ServerInit } from '@sveltejs/kit/hooks';
import { pathLocale } from '#lib/i18n/index.ts';
import { readRequestLocation } from '#lib/v1/requestLocation.ts';
import { readPublicSiteConfig } from '#lib/site/config.ts';
import { lineFrameView } from '#lib/site/lineFrame.ts';
import { networkRecordView } from '#lib/site/networkFrame.ts';
import { stopFrameView } from '#lib/site/stopFrame.ts';
import { DOCUMENT_SECURITY_HEADERS } from '#lib/site/securityHeaders.ts';
import { configureTransitUi } from '#lib/ui/configure.ts';
import { preloadFont } from '@yesid/tokens/fonts';
import { injectAnnouncementBannerBoot, injectThemeBoot } from '@yesid/ui/head';
import { announcement } from '#lib/site/announcement.ts';

export const init: ServerInit = configureTransitUi;

export const handleError: HandleServerError = ({ kind, error, event }) => {
	if (kind === 'validation' || (kind !== 'unknown' && error.status < 500)) return;
	// Route templates are code-owned. URLs, headers, messages and stacks may
	// contain address searches or other personal input and must not be persisted.
	console.error({ event: 'server_error', route: event.route.id });
};

const HTML_EDGE_TTL_S = 30;
const HTML_EDGE_CACHE_NAME = 'transit-html-v1';
const HTML_EDGE_CACHE_CONTROL = `public, max-age=0, s-maxage=${HTML_EDGE_TTL_S}`;
const HTML_PUBLIC_CACHE_CONTROL = 'no-store';
const EDGE_CACHE_STATUS = 'x-transit-edge-cache';

interface EdgeCache {
	match(request: RequestInfo | URL): Promise<Response | undefined>;
	put(request: RequestInfo | URL, response: Response): Promise<void>;
}

async function edgeCache(): Promise<EdgeCache | undefined> {
	try {
		return (await globalThis.caches?.open(HTML_EDGE_CACHE_NAME)) as EdgeCache | undefined;
	} catch {
		return undefined;
	}
}

function cacheKey(url: URL): Request {
	return new Request(url.toString(), { method: 'GET' });
}

function requestBypassesHtmlCache(request: Request): boolean {
	if (request.method !== 'GET' && request.method !== 'HEAD') return true;
	if (
		request.headers.has('cookie') ||
		request.headers.has('authorization') ||
		request.headers.has('range')
	) {
		return true;
	}
	const cacheControl = request.headers.get('cache-control')?.toLowerCase() ?? '';
	return /(?:^|,)\s*no-(?:cache|store)(?:\s*(?:=|,|$))/.test(cacheControl);
}

function isHtml(response: Response): boolean {
	return (response.headers.get('content-type') ?? '').toLowerCase().includes('text/html');
}

function hasScriptNonce(response: Response): boolean {
	return response.headers.get('content-security-policy')?.includes("'nonce-") === true;
}

function responseCanEnterHtmlCache(response: Response): boolean {
	if (
		response.status !== 200 ||
		!isHtml(response) ||
		response.headers.has('set-cookie') ||
		hasScriptNonce(response)
	)
		return false;
	const cacheControl = response.headers.get('cache-control')?.toLowerCase() ?? '';
	if (/(?:^|,)\s*(?:private|no-cache|no-store)(?:\s*(?:=|,|$))/.test(cacheControl)) return false;
	return response.headers.get('vary')?.trim() !== '*';
}

function mutableResponse(response: Response, head = false): Response {
	return new Response(head ? null : response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

function acceptsGzip(request: Request): boolean {
	// Cloudflare can replace Accept-Encoding before it reaches the Worker.
	const clientEncoding = (request as Request & { cf?: { clientAcceptEncoding?: string } }).cf
		?.clientAcceptEncoding;
	const header = clientEncoding ?? request.headers.get('accept-encoding');
	const weights = new Map<string, number>();
	for (const entry of header?.toLowerCase().split(',') ?? []) {
		const match = /^\s*([\w*-]+)\s*(?:;\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?\s*$/.exec(
			entry,
		);
		if (match) weights.set(match[1], match[2] == null ? 1 : Number(match[2]));
	}
	const gzip = weights.get('gzip') ?? weights.get('*') ?? 0;
	return gzip > 0 && gzip >= (weights.get('identity') ?? 0);
}

function streamedResponse(response: Response, request: Request): Response {
	response.headers.set('cache-control', 'no-store, no-transform');
	response.headers.set('content-encoding', 'identity');
	if (response.status !== 200 || (request.method !== 'GET' && request.method !== 'HEAD'))
		return response;

	const vary = response.headers
		.get('vary')
		?.toLowerCase()
		.split(',')
		.map((name) => name.trim());
	if (!vary?.includes('*') && !vary?.includes('accept-encoding'))
		response.headers.append('vary', 'Accept-Encoding');
	if (!response.body || !acceptsGzip(request)) return response;

	// Make each SvelteKit chunk decodable before the next one is ready.
	const gzip = Duplex.toWeb(createGzip({ level: 1, flush: constants.Z_SYNC_FLUSH }));
	response.headers.set('content-encoding', 'gzip');
	response.headers.delete('content-length');
	response.headers.delete('etag');
	return new Response(response.body.pipeThrough<Uint8Array>(gzip), {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
		encodeBody: 'manual',
	} as ResponseInit & { encodeBody: 'manual' });
}

function applyDocumentHeaders(response: Response, url: URL): void {
	for (const [name, value] of Object.entries(DOCUMENT_SECURITY_HEADERS)) {
		response.headers.set(name, value);
	}

	// Version and preview URLs live on workers.dev and must never be indexed.
	if (!readPublicSiteConfig().indexing || url.hostname.endsWith('.workers.dev')) {
		response.headers.set('x-robots-tag', 'noindex, nofollow');
	}
}

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.approximateLocation = readRequestLocation(event.request);
	const overviewRecord =
		event.route.id === '/[[lang=locale]]' && event.url.searchParams.get('frameMode') !== 'live';
	const lineView =
		event.route.id === '/[[lang=locale]]/lines/[id]' ? lineFrameView(event.url) : null;
	const stopRecord =
		event.route.id === '/[[lang=locale]]/stop/[id]' && stopFrameView(event.url) === 'record';
	const vehicleRecord =
		(event.route.id === '/[[lang=locale]]/vehicles' ||
			event.route.id === '/[[lang=locale]]/vehicle/[id]') &&
		event.url.searchParams.get('frameMode') !== 'live';
	const rankingsRecord = event.route.id === '/[[lang=locale]]/rankings';
	const method = event.route.id === '/[[lang=locale]]/metrics';
	const healthRecord =
		event.route.id === '/[[lang=locale]]/status' &&
		event.url.searchParams.get('frameMode') !== 'live';
	const finderRecord =
		event.route.id === '/[[lang=locale]]/lines' || event.route.id === '/[[lang=locale]]/stops';
	const streamedRecord =
		overviewRecord ||
		(event.route.id === '/[[lang=locale]]/network' && networkRecordView(event.url)) ||
		stopRecord ||
		vehicleRecord ||
		rankingsRecord ||
		finderRecord ||
		lineView !== null ||
		method ||
		healthRecord ||
		(event.route.id === '/[[lang=locale]]/alerts' &&
			event.url.searchParams.get('frameMode') !== 'live') ||
		event.route.id === '/[[lang=locale]]/receipt' ||
		event.route.id === '/[[lang=locale]]/departure/[key]';
	const automaticSelection =
		event.route.id?.startsWith('/[[lang=locale]]') === true &&
		!event.url.searchParams.has('provider') &&
		event.locals.approximateLocation != null;

	const lang = pathLocale(event.url.pathname);
	event.locals.locale = lang;
	const cache = await edgeCache();
	const cacheBypassed =
		streamedRecord ||
		automaticSelection ||
		event.isDataRequest ||
		cache == null ||
		requestBypassesHtmlCache(event.request);
	const key = cacheBypassed ? null : cacheKey(event.url);

	if (cache != null && key != null) {
		let hit: Response | undefined;
		try {
			hit = await cache.match(key);
		} catch {
			// Edge cache is an optimization. SSR remains the fail-open authority.
		}
		if (hit != null && responseCanEnterHtmlCache(hit)) {
			const response = mutableResponse(hit, event.request.method === 'HEAD');
			applyDocumentHeaders(response, event.url);
			response.headers.set('cache-control', HTML_PUBLIC_CACHE_CONTROL);
			response.headers.set(EDGE_CACHE_STATUS, 'HIT');
			return response;
		}
	}

	const resolved = await resolve(event, {
		transformPageChunk: ({ html }) =>
			injectAnnouncementBannerBoot(
				injectThemeBoot(html.replace('%lang%', lang)),
				announcement.enabled ? announcement.id : undefined,
			),
		preload: ({ type, path }) => type !== 'font' || preloadFont(path),
	});
	let response = mutableResponse(resolved, event.request.method === 'HEAD');
	if (streamedRecord && response.ok) {
		response = streamedResponse(response, event.request);
	} else if (automaticSelection || hasScriptNonce(response)) {
		// A runtime nonce belongs to this response.
		response.headers.set('cache-control', 'no-store');
	}

	applyDocumentHeaders(response, event.url);

	if (cache != null) {
		if (key != null && event.request.method === 'GET' && responseCanEnterHtmlCache(response)) {
			const stored = response.clone();
			stored.headers.set('cache-control', HTML_EDGE_CACHE_CONTROL);
			stored.headers.delete(EDGE_CACHE_STATUS);
			const write = cache.put(key, stored).catch(() => undefined);
			waitUntil(write);
			response.headers.set('cache-control', HTML_PUBLIC_CACHE_CONTROL);
			response.headers.set(EDGE_CACHE_STATUS, 'MISS');
		} else {
			response.headers.set(EDGE_CACHE_STATUS, 'BYPASS');
		}
	}
	return response;
};
