import { test as base, type Route } from '@playwright/test';
import { forwardRoute } from './layout-helpers';

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
						/(?:^|;)\s*upgrade-insecure-requests\s*(?=;|$)/g,
						'',
					);
				await route.fulfill({ response, headers });
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
					// In Playwright 1.62, a completed _onRoute callback independently clears
					// interception when the client route list is empty, even during a wait.
					// Repopulate it after unrouteAll clears it and before any callback resumes.
					const fallback = (route: Route) => route.fallback();
					const draining = page.unrouteAll({ behavior: 'wait' });
					await Promise.all([draining, page.route('**/*', fallback)]);
					await page.unroute('**/*', fallback);
				});
		}
	},
});
