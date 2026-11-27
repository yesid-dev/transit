import { randomUUID } from 'node:crypto';
import { test as base, type APIRequestContext } from '@playwright/test';

export async function startStopSearchFixture(request: APIRequestContext) {
	const port = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';
	const origin = `http://127.0.0.1:${port}`;
	const scope = `stops-search:${randomUUID()}`;
	const query = new URLSearchParams({ fixture: scope });
	const endpoint = `${origin}/__stops-search?${query}`;
	const options = { failOnStatusCode: true };
	await request.put(endpoint, options);
	return {
		headers: { 'x-transit-fixture-scope': scope },
		questions: async (): Promise<number> => (await request.get(endpoint, options)).json(),
		hold: () => request.post(endpoint, options),
		release: () => request.post(`${origin}/__overview/release?${query}`, options),
		dispose: () => request.delete(endpoint, options),
	};
}

type StopSearchFixture = Awaited<ReturnType<typeof startStopSearchFixture>>;

export const test = base.extend<{ stopSearch: StopSearchFixture }>({
	stopSearch: async ({ page, request }, use) => {
		const fixture = await startStopSearchFixture(request);
		try {
			await page.setExtraHTTPHeaders(fixture.headers);
			await use(fixture);
		} finally {
			await fixture.dispose();
		}
	},
});
