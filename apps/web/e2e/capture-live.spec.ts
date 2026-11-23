import { expect, test } from '@playwright/test';
import { captureFixture, captureUrl, captureVehicle } from './capture-fixture';

test('the Transit1 live vehicle reads the capture snapshot in English and French', async ({
	page,
}) => {
	const legacyRequests: string[] = [];
	page.on('request', (request) => {
		const { pathname } = new URL(request.url());
		if (/^(?:\/data)?\/v1\//.test(pathname)) legacyRequests.push(pathname);
	});
	for (const lang of ['en', 'fr']) {
		const response = page.waitForResponse((reply) => {
			const url = new URL(reply.url());
			return url.pathname === '/api/live' && url.searchParams.get('city') === 'stm' && reply.ok();
		});
		await page.goto(`${lang === 'fr' ? '/fr' : ''}/vehicle/40061?provider=stm&frameMode=live`);
		await response;
		const main = page.getByRole('main');
		await expect(main.getByText(lang === 'fr' ? 'Peu de places' : 'Few seats')).toBeVisible();
		await expect(main.getByRole('link', { name: /T1/ })).toHaveAttribute('href', /trip\/T1/);
	}
	expect(legacyRequests).toEqual([]);
});

test('rail detail uses schedule geometry and omits vehicles from a line without live coverage', async ({
	page,
}) => {
	await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
	const now = Date.now();
	await page.route(captureUrl, (route) =>
		route.fulfill({
			json: captureFixture(now, {
				vehicle_positions: [captureVehicle(now, { route_id: '1-373' })],
			}),
		}),
	);
	const scheduleResponse = page.waitForResponse(
		(response) => new URL(response.url()).pathname === '/api/schedule-edition' && response.ok(),
	);
	const snapshotResponse = page.waitForResponse((response) => captureUrl.test(response.url()));
	await page.goto('/map?provider=stm&mapview=-73.595,45.505,15,0,0');
	const schedule = await (await scheduleResponse).json();
	expect(schedule.schedule.route_directions['1-373'][0].shape.type).toBe('LineString');
	await snapshotResponse;
	await expect(page.getByTestId('map-progressive')).toHaveAttribute(
		'data-map-progressive-state',
		'ready',
	);
	await page.locator('.maplibregl-canvas').click();
	const detail = page
		.getByRole('complementary', { name: /Confederation|1/ })
		.or(page.getByRole('dialog', { name: /Confederation|1/ }));
	await expect(detail.getByText('No live data', { exact: true })).toBeVisible();
});
