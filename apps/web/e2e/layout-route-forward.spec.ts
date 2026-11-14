import { createServer, type ServerResponse } from 'node:http';
import { expect, test } from '@playwright/test';
import { installLayoutRoutes } from './layout-helpers';

for (const action of ['abort', 'unroute', 'complete'] as const)
	test(`layout forwarding survives ${action} during a held response`, async ({ page }) => {
		let received!: (response: ServerResponse) => void;
		const reached = new Promise<ServerResponse>((resolve) => (received = resolve));
		const server = createServer((request, response) => {
			if (request.url === '/') response.end('<html></html>');
			else if (request.url?.includes('/v1/')) received(response);
			else response.writeHead(404).end();
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		try {
			const address = server.address();
			if (!address || typeof address === 'string') throw new Error('Missing server port');
			await page.goto(`http://127.0.0.1:${address.port}/`);
			const remove = await installLayoutRoutes(page, 'fresh');
			await page.evaluate(() => {
				const controller = new AbortController();
				Object.assign(window, { cancelFixture: () => controller.abort() });
				Object.assign(window, {
					fixtureResult: fetch('/v1/held.json?probe=1', { signal: controller.signal }).then(
						(response) => response.text(),
						(error: Error) => error.name,
					),
				});
			});
			const response = await reached;
			expect(response.req.url).toBe('/__layout/fresh/v1/held.json?probe=1');
			if (action === 'abort') await page.evaluate(() => Reflect.get(window, 'cancelFixture')());
			let removed = false;
			const removing = action === 'unroute' ? remove().then(() => (removed = true)) : null;
			await page.evaluate(() => document.readyState);
			if (action === 'unroute') expect(removed).toBe(false);
			response.end('fixture response');
			await (removing ?? remove());
			expect(await page.evaluate(() => Reflect.get(window, 'fixtureResult'))).toBe(
				action === 'abort' ? 'AbortError' : 'fixture response',
			);
			expect(page.isClosed()).toBe(false);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});
