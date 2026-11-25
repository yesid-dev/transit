import { expect, test } from '@playwright/test';
import { alertUnavailableCopy } from '../src/lib/components/surface/alertAvailabilityCopy';
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
		await main
			.getByRole('button', { name: lang === 'fr' ? 'Voir les prévisions' : 'View predictions' })
			.click();
		await expect(
			page
				.getByRole('dialog')
				.getByText(
					lang === 'fr'
						? 'Ce sont des prévisions, pas des arrivées observées.'
						: 'These are predictions, not observed arrivals.',
				),
		).toBeVisible();
	}
	expect(legacyRequests).toEqual([]);
});

test('Vehicle Live waits for the trip publication to refresh', async ({ page }) => {
	const scoped = /\/api\/live-trips\?city=stm&trip=T1$/;
	let attempts = 0;
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route(scoped, async (route) => {
		if (++attempts > 1) {
			await held;
			return route.continue();
		}
		return route.fulfill({
			status: 503,
			headers: { 'retry-after': '1' },
			json: { state: 'refreshing' },
		});
	});
	const refreshing = page.waitForResponse(
		(response) => scoped.test(response.url()) && response.status() === 503,
	);
	const current = page.waitForResponse((response) => scoped.test(response.url()) && response.ok());
	try {
		await page.goto('/vehicle/40061?provider=stm&frameMode=live');
		await refreshing;
		await page.getByRole('button', { name: 'View predictions' }).click();
		await expect(page.getByRole('dialog').getByRole('status')).toHaveText('Loading predictions…');
		await expect(
			page.getByText('No predictions reported for this trip in this window.'),
		).toHaveCount(0);
		release();
		await current;
		await expect(page.getByText('These are predictions, not observed arrivals.')).toBeVisible();
	} finally {
		release();
	}
});

test('Departure Live shows the redirected prediction report and preserves its CSV', async ({
	page,
}) => {
	await page.goto(
		'/fr/trip/departure-without-vehicle?provider=stm&recordFrom=2026-11-08&recordTo=2026-11-14',
	);
	await expect(page).toHaveURL(/\/fr\/departure\//);
	const report = page.getByRole('article', { name: 'Prévisions communiquées' });
	await expect(
		report.getByText('Ce sont des prévisions, pas des arrivées observées.'),
	).toBeVisible();
	await expect(report.getByRole('table')).toBeVisible();
	await expect(
		report.getByRole('link', { name: 'Télécharger toutes les prévisions (CSV)' }),
	).toHaveAttribute('download', 'trip-departure-without-vehicle-all-predictions.csv');
});

test('Live alerts display capture evidence and distinguish unsupported coverage', async ({
	page,
}) => {
	const at = Date.now();
	const header = { en: 'Elevator closed for repair', fr: 'Ascenseur fermé pour réparation' };
	await page.route(captureUrl, (route) => {
		const city = new URL(route.request().url()).searchParams.get('city')!;
		return route.fulfill({
			json: captureFixture(at, {
				city,
				alerts: [
					{
						id: 'elevator-closure',
						header,
						description: {},
						url: {},
						cause: null,
						effect: null,
						severity: 'WARNING',
						routes: ['24'],
						stops: ['S1'],
						periods: [[new Date(at - 60_000).toISOString(), new Date(at + 300_000).toISOString()]],
					},
				],
			}),
		});
	});
	for (const locale of ['en', 'fr'] as const) {
		const href = locale === 'fr' ? '/fr/alerts' : '/alerts';
		await page.goto(`${href}?provider=stm&frameMode=live`);
		await expect(page.getByText(header[locale], { exact: true })).toBeVisible();
		await page.goto(`${href}?provider=octranspo&frameMode=live`);
		await expect(
			page.getByRole('status').filter({ hasText: alertUnavailableCopy[locale].title }),
		).toBeVisible();
	}
});

test('data health distinguishes an aged capture from an unavailable response', async ({ page }) => {
	const at = Date.now();
	let missing = false;
	await page.route(captureUrl, (route) =>
		missing
			? route.fulfill({ status: 404, json: { state: 'no_live_data' } })
			: route.fulfill({ json: captureFixture(at - 120_000) }),
	);
	await page.goto('/status?provider=stm&frameMode=live');
	const live = page.locator('[data-slot="health-summary"] [data-answer="live"]');
	await expect(live.locator('.health-answer-mark')).toHaveAttribute('data-state', 'behind');
	missing = true;
	await page.reload();
	await expect(live.locator('.health-answer-mark')).toHaveAttribute('data-state', 'unknown');
	await expect(live.locator('p > span:not([aria-hidden])')).toHaveText(/update time unknown/i);
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
	const shapeResponse = page.waitForResponse((response) => {
		const url = new URL(response.url());
		return (
			url.pathname === '/api/schedule-map' &&
			(url.searchParams.get('lines') ?? '').includes('1-373') &&
			response.ok()
		);
	});
	const snapshotResponse = page.waitForResponse((response) => captureUrl.test(response.url()));
	await page.route('**/api/stops/slim?provider=stm', (route) =>
		route.fulfill({
			json: { generated_utc: new Date(now).toISOString(), stops: [] },
		}),
	);
	const rail = [-73.595, 45.505];
	await page.goto(`/map?provider=stm&mapview=${rail.join(',')},15,0,0`);
	const schedule = await (await scheduleResponse).json();
	expect(schedule.schedule.route_directions['1-373'][0]).not.toHaveProperty('shape');
	const shapes = await (await shapeResponse).json();
	expect(shapes.schedule.route_shapes['1-373'][0].shape.type).toBe('LineString');
	await snapshotResponse;
	await expect(page.getByTestId('map-progressive')).toHaveAttribute(
		'data-map-progressive-state',
		'ready',
	);
	const canvas = page.locator('.maplibregl-canvas');
	await expect
		.poll(async () => {
			await canvas.hover();
			return canvas.evaluate((node) => (node as HTMLElement).style.cursor);
		})
		.toBe('pointer');
	await canvas.click();
	const detail = page
		.getByRole('complementary', { name: /Confederation|1/ })
		.or(page.getByRole('dialog', { name: /Confederation|1/ }));
	await expect(detail.getByText('No live data', { exact: true })).toBeVisible();
});
