import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { test } from './layout-test';
import { forwardRoute } from './layout-helpers';

const body = readFileSync(new URL('./trips.json', import.meta.url), 'utf8');
const heldResponses: ServerResponse[] = [];
let handle!: (request: IncomingMessage, response: ServerResponse) => void;
const server = createServer((request, response) => handle(request, response));

test.beforeAll(async () => {
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});
test.afterAll(async () => {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
	expect(
		heldResponses.every((response) => response.writableEnded),
		'fixture released every held response',
	).toBe(true);
});

async function holdRequests(page: Page) {
	const responses: ServerResponse[] = [];
	const unrewritten: string[] = [];
	let received!: () => void;
	const bothReceived = new Promise<void>((resolve) => (received = resolve));
	handle = (request, response) => {
		if (request.url === '/') return void response.end('<html></html>');
		if (request.url?.startsWith('/__layout/fresh/v1/')) {
			heldResponses.push(response);
			responses[request.url.includes('/first.json') ? 0 : 1] = response;
			if (responses[0] && responses[1]) received();
		} else {
			if (request.url?.startsWith('/v1/')) unrewritten.push(request.url);
			response.end(body);
		}
	};
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Missing server port');
	let forwarded!: () => void;
	const firstForwarded = new Promise<void>((resolve) => (forwarded = resolve));
	await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
	await page.route('**/v1/**', (route) =>
		forwardRoute(page, async () => {
			const url = new URL(route.request().url());
			url.pathname = `/__layout/fresh${url.pathname}`;
			await route.fulfill({ response: await route.fetch({ url: url.href }) });
			if (url.pathname.endsWith('/first.json')) forwarded();
		}),
	);
	await page.goto(`http://127.0.0.1:${address.port}/`);
	await page.evaluate(() => {
		const controller = new AbortController();
		Object.assign(window, {
			cancelFixture: () => controller.abort(),
			firstBody: fetch('/v1/first.json').then((response) => response.text()),
			secondBody: fetch('/v1/second.json?probe=1', { signal: controller.signal }).then(
				(response) => response.text(),
				(error: Error) => error.name,
			),
		});
	});
	await bothReceived;
	expect(responses[1].req.url).toBe('/__layout/fresh/v1/second.json?probe=1');
	return { responses, unrewritten, firstForwarded };
}

for (const action of ['abort', 'unroute', 'complete'] as const)
	test(`layout forwarding survives ${action} during a held response`, async ({ page }) => {
		const { responses, unrewritten, firstForwarded } = await holdRequests(page);
		if (action === 'unroute') {
			// Observe the real layout-test fixture's teardown, preserving its API/options.
			// Finish one callback while the other is still fetching during the drain.
			const unrouteAll = page.unrouteAll.bind(page);
			page.unrouteAll = async (options) => {
				page.unrouteAll = unrouteAll;
				expect(options).toEqual({ behavior: 'wait' });
				const draining = unrouteAll(options);
				responses[0].end(body);
				await firstForwarded;
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(await page.evaluate(() => Reflect.get(window, 'firstBody'))).toBe(body);
				responses[1].end(body);
				await draining;
				expect(await page.evaluate(() => Reflect.get(window, 'secondBody'))).toBe(body);
				expect(unrewritten).toEqual([]);
				expect(page.isClosed()).toBe(false);
			};
			return;
		}
		if (action === 'abort') await page.evaluate(() => Reflect.get(window, 'cancelFixture')());
		responses.forEach((response) => response.end(body));
		expect(await page.evaluate(() => Reflect.get(window, 'firstBody'))).toBe(body);
		expect(await page.evaluate(() => Reflect.get(window, 'secondBody'))).toBe(
			action === 'abort' ? 'AbortError' : body,
		);
		expect(unrewritten).toEqual([]);
		expect(page.isClosed()).toBe(false);
	});
