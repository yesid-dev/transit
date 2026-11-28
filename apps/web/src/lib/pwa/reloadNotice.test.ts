// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import source from './reloadNotice.js?raw';

const failedImport = () =>
	window.dispatchEvent(
		Object.assign(new Event('unhandledrejection'), {
			reason: new TypeError('Failed to fetch dynamically imported module: /_app/immutable/x.js'),
		}),
	);

let reload: ReturnType<typeof vi.fn>;
type Listener = {
	type: string;
	listener: EventListenerOrEventListenerObject;
	options?: boolean | AddEventListenerOptions;
};
let listeners: Listener[];

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

beforeEach(() => {
	sessionStorage.clear();
	reload = vi.fn();
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => Response.json({ version: '1' })),
	);
	Object.defineProperty(window, 'location', {
		configurable: true,
		value: { href: 'https://transit.test/lines/51?frameMode=live', reload },
	});
	// Each boot adds window listeners; remove them so one test's script does not answer the next.
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

it('reloads by itself once when a script of the page fails to load', () => {
	const notice = boot();
	failedImport();
	expect(reload).toHaveBeenCalledOnce();
	expect(notice.hidden).toBe(true);
});

it('offers the button instead of reloading again within a minute', async () => {
	boot();
	failedImport();
	expect(reload).toHaveBeenCalledOnce();
	// The reloaded page fails too: it says so and waits for the reader.
	forget();
	const notice = boot();
	failedImport();
	expect(reload).toHaveBeenCalledOnce();
	expect(notice.hidden).toBe(false);
	expect(notice.querySelector('[data-reload-message]')!.textContent).toBe(
		'This page could not load.',
	);
});

it('reloads again for a failure on another page', () => {
	boot();
	failedImport();
	Object.assign(window.location, { href: 'https://transit.test/stop/S1' });
	forget();
	boot();
	failedImport();
	expect(reload).toHaveBeenCalledTimes(2);
});
