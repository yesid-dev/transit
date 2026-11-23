import { createServer, request } from 'node:http';
import { test as base, type Route } from '@playwright/test';
import { forwardRoute } from './layout-helpers';
import { captureUrl, layoutCapture } from './capture-fixture';

const upgradeDirective = /(?:^|;)\s*upgrade-insecure-requests\s*(?=;|$)/g;

// WebKit applies upgrade-insecure-requests even with bypassCSP. Wrangler's local
// HTTP server has no TLS listener; keep this one directive out of fixture HTML.
export const test = base.extend({
	page: async ({ page, browserName, baseURL }, use) => {
		if (browserName === 'webkit')
			await page.route('**/*', async (route) => {
				if (
					!route.request().isNavigationRequest() ||
					new URL(route.request().url()).origin !== new URL(baseURL!).origin
				) {
					await route.fallback();
					return;
				}
				const response = await route.fetch();
				const headers = response.headers();
				if (headers['content-security-policy'])
					headers['content-security-policy'] = headers['content-security-policy'].replace(
						upgradeDirective,
						'',
					);
				await route.fulfill({ response, headers });
			});
		await page.route(captureUrl, (route) => {
			const city = new URL(route.request().url()).searchParams.get('city')!;
			return route.fulfill({ json: layoutCapture(city) });
		});
		try {
			await use(page);
		} finally {
			// Drain every spec's handlers while their page and fetched responses still
			// exist. Waiting preserves real route failures instead of discarding them.
			// A context closed by the test has already disposed its request client;
			// its interrupted handlers can no longer complete a drain operation.
			if (!page.isClosed())
				await forwardRoute(page, async () => {
					// In the pinned Playwright release, a completed _onRoute callback independently
					// clears interception when the client route list is empty, even during a wait.
					// Repopulate it after unrouteAll clears it and before any callback resumes.
					const fallback = (route: Route) => route.fallback();
					const draining = page.unrouteAll({ behavior: 'wait' });
					await Promise.all([draining, page.route('**/*', fallback)]);
					await page.unroute('**/*', fallback);
				});
		}
	},
});

// route.fetch/fulfill buffers the document. A local relay gives WebKit the same
// CSP adjustment while forwarding each part of the actual streamed response.
export const streamingLayoutTest = base.extend({
	baseURL: async ({ baseURL, browserName }, use) => {
		if (browserName !== 'webkit') {
			await use(baseURL);
			return;
		}
		const worker = new URL(baseURL!);
		if (worker.protocol !== 'http:' || worker.hostname !== '127.0.0.1')
			throw new Error('Streaming relay requires a loopback HTTP worker');
		const relay = createServer((incoming, outgoing) => {
			const path = incoming.url;
			if (!path?.startsWith('/') || path.startsWith('//')) {
				outgoing.writeHead(400).end();
				return;
			}
			const upstream = request(
				{
					hostname: '127.0.0.1',
					port: worker.port,
					path,
					method: incoming.method,
					headers: { ...incoming.headers, host: worker.host },
				},
				(response) => {
					const headers = { ...response.headers };
					const csp = headers['content-security-policy'];
					if (typeof csp === 'string')
						headers['content-security-policy'] = csp.replace(upgradeDirective, '');
					outgoing.writeHead(response.statusCode!, headers);
					response.pipe(outgoing);
				},
			);
			upstream.on('error', (error) => outgoing.destroy(error));
			outgoing.on('close', () => upstream.destroy());
			incoming.pipe(upstream);
		});
		await new Promise<void>((resolve, reject) => {
			relay.once('error', reject);
			relay.listen(0, '127.0.0.1', resolve);
		});
		const address = relay.address();
		if (!address || typeof address === 'string') throw new Error('Streaming relay did not bind');
		try {
			await use(`http://127.0.0.1:${address.port}`);
		} finally {
			await new Promise<void>((resolve) => {
				relay.close(() => resolve());
				relay.closeAllConnections();
			});
		}
	},
});
