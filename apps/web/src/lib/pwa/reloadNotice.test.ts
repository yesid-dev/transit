// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import source from './reloadNotice.js?raw';

const ORIGIN = 'https://transit.test';
const CHUNK = `${ORIGIN}/_app/immutable/chunks/Gone.js`;

const failedImport = (message = `Failed to fetch dynamically imported module: ${CHUNK}`) =>
	window.dispatchEvent(
		Object.assign(new Event('unhandledrejection'), { reason: new TypeError(message) }),
	);

/** An element whose load failed, as the browser reports it to a capturing listener. */
function failedElement(element: HTMLElement) {
	document.body.append(element);
	element.dispatchEvent(new Event('error'));
}

type Listener = {
	type: string;
	listener: EventListenerOrEventListenerObject;
	options?: boolean | AddEventListenerOptions;
};
let listeners: Listener[];
let reload: ReturnType<typeof vi.fn>;
let deployed: string;
let chunkStatus: number;
let requests: string[];

/** Removes the listeners the booted scripts added, as a new page would start without them. */
function forget() {
	for (const { type, listener, options } of listeners.splice(0))
		window.removeEventListener(type, listener, options);
}

function boot() {
	document.body.innerHTML = `<div id="app-reload-notice" hidden data-version="1" data-version-url="/_app/version.json">
		<p data-reload-message></p><button type="button"></button></div>`;
	new Function(source)();
	return document.getElementById('app-reload-notice')!;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	sessionStorage.clear();
	reload = vi.fn();
	deployed = '1';
	chunkStatus = 404;
	requests = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: string, init?: RequestInit) => {
			requests.push(`${init?.method ?? 'GET'} ${input}`);
			if (String(input).includes('version.json')) return Response.json({ version: deployed });
			return new Response(null, { status: chunkStatus });
		}),
	);
	Object.defineProperty(window, 'location', {
		configurable: true,
		value: { href: `${ORIGIN}/lines/51?frameMode=live`, origin: ORIGIN, reload },
	});
	listeners = [];
	const add = window.addEventListener.bind(window);
	vi.spyOn(window, 'addEventListener').mockImplementation(((
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: boolean | AddEventListenerOptions,
	) => {
		listeners.push({ type, listener, options });
		add(type, listener, options);
	}) as typeof window.addEventListener);
});

afterEach(() => {
	forget();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it('reloads once when one of the app’s own scripts is really gone', async () => {
	const notice = boot();
	failedImport();
	await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
	expect(requests).toEqual(['GET /_app/version.json', `HEAD ${CHUNK}`]);
	expect(notice.hidden).toBe(true);
});

it('reloads once for a newer deploy when the browser names no file', async () => {
	deployed = '2';
	boot();
	failedImport('Importing a module script failed.');
	await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
});

it('does not reload for a load aborted because the reader is leaving the page', async () => {
	boot();
	window.dispatchEvent(new Event('pagehide'));
	failedImport();
	const preload = Object.assign(document.createElement('link'), {
		rel: 'modulepreload',
		href: CHUNK,
	});
	failedElement(preload);
	await settle();
	expect(requests).toEqual([]);
	expect(reload).not.toHaveBeenCalled();
});

it('does not reload when the reader leaves while the failure is being checked', async () => {
	boot();
	failedImport();
	window.dispatchEvent(new Event('beforeunload'));
	await settle();
	await settle();
	expect(reload).not.toHaveBeenCalled();
});

it('ignores failures that are not the app’s own content-named files', async () => {
	const notice = boot();
	for (const src of ['https://plausible.io/js/script.js', `${ORIGIN}/favicon.svg`])
		failedElement(Object.assign(document.createElement('script'), { src }));
	failedElement(Object.assign(document.createElement('img'), { src: `${ORIGIN}/poster.png` }));
	window.dispatchEvent(
		Object.assign(new Event('unhandledrejection'), { reason: new Error('Request aborted') }),
	);
	await settle();
	expect(requests).toEqual([]);
	expect(reload).not.toHaveBeenCalled();
	expect(notice.hidden).toBe(true);
});

it('says the page could not load, without reloading, when the file is still there', async () => {
	chunkStatus = 200;
	const notice = boot();
	failedImport();
	await vi.waitFor(() => expect(notice.hidden).toBe(false));
	expect(reload).not.toHaveBeenCalled();
	expect(notice.querySelector('[data-reload-message]')!.textContent).toBe(
		'This page could not load.',
	);
});

it('offers the button instead of reloading again within a minute', async () => {
	boot();
	failedImport();
	await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
	// The reloaded page fails too: it says so and waits for the reader.
	forget();
	const notice = boot();
	failedImport();
	await vi.waitFor(() => expect(notice.hidden).toBe(false));
	expect(reload).toHaveBeenCalledOnce();
});
