import { expect, test } from '@playwright/test';

test('health reports the proxy and engine through the question transport', async ({ request }) => {
	// The fixture serves the question probe without an R2 binding.
	const response = await request.get('/health');
	expect(response.status()).toBe(200);
	expect(response.headers()['cache-control']).toBe('no-store');
	expect(await response.json()).toMatchObject({
		status: 'ok',
		service: 'transit1-web',
		proxy: 'ok',
		engine: 'ok',
		commit: null,
		branch: null,
	});
});
