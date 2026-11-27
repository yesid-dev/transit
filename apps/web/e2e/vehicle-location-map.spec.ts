import { expect, test, type Locator, type Page } from '@playwright/test';
import { join } from 'node:path';
import {
	captureFixture,
	captureTrip,
	captureTripReport,
	captureUrl,
	captureVehicle,
	liveTripsUrl,
} from './capture-fixture';

const path = '/vehicle/40061?provider=stm&frameMode=live';
const previewSlot = '[data-slot="vehicle-map-preview"]';
const attributionButton = '.maplibregl-ctrl-attrib-button';
const scheduleMap = /\/api\/schedule-map\?city=stm&lines=/;
const positions = { S1: [-73.5985, 45.5005], S2: [-73.6015, 45.4995] } as const;
const directions = [
	{
		dir: 0,
		headsign: 'West',
		stops: [
			{ id: 'S1', seq: 1 },
			{ id: 'S2', seq: 2 },
		],
	},
	{
		dir: 1,
		headsign: 'East',
		stops: [
			{ id: 'S2', seq: 1 },
			{ id: 'S1', seq: 2 },
		],
	},
];

async function livePosition(page: Page) {
	const now = Date.now();
	await page.route(captureUrl, (route) =>
		route.fulfill({
			json: captureFixture(now, { vehicle_positions: [captureVehicle(now, { bearing: 80 })] }),
		}),
	);
	await page.route(liveTripsUrl, (route) =>
		route.fulfill({
			json: captureTripReport('stm', new Date(now).toISOString(), [
				{
					...captureTrip(
						'T1',
						'24',
						['S2', 'S1'].map((stop, index) => ({
							stop,
							eta_utc: new Date(now + (index + 1) * 60_000).toISOString(),
						})),
					),
					direction_id: 1,
					trip_headsign: 'East',
				},
			]),
		}),
	);
	await page.route(/\/api\/schedule-edition\?city=stm$/, async (route) => {
		const response = await route.fetch();
		const body = await response.json();
		body.schedule.route_directions['24'] = directions;
		await route.fulfill({ response, json: body });
	});
	await page.route(/\/api\/stops\/slim\?provider=stm$/, (route) =>
		route.fulfill({
			json: {
				generated_utc: new Date(now).toISOString(),
				stops: [
					{ id: 'S1', name: 'Sherbrooke / Atwater', lon: positions.S1[0], lat: positions.S1[1] },
					{ id: 'S2', name: 'Sherbrooke / Wood', lon: positions.S2[0], lat: positions.S2[1] },
				],
			},
		}),
	);
	await page.route(scheduleMap, async (route) => {
		const response = await route.fetch();
		const body = await response.json();
		body.schedule.route_shapes['24'] = [
			{
				dir: 0,
				headsign: 'West',
				shape: { type: 'LineString', coordinates: [positions.S1, [-73.6, 45.5015], positions.S2] },
			},
			{
				dir: 1,
				headsign: 'East',
				shape: { type: 'LineString', coordinates: [positions.S2, [-73.6, 45.5], positions.S1] },
			},
		];
		await route.fulfill({ response, json: body });
	});
}

test.use({ bypassCSP: true });
test.beforeEach(({ browserName }, info) => {
	test.skip(browserName !== 'chromium' || info.project.name !== 'desktop');
});

async function expectSingleAttributionIcon(button: Locator) {
	await expect(button).toBeVisible();
	await expect(button).not.toHaveCSS('background-image', 'none');
	await expect(button).toHaveCSS('background-repeat', 'no-repeat');
	await expect(button).toHaveCSS('background-position', '50% 50%');
	await expect(button).toHaveCSS('background-size', '24px 24px');
}

for (const [width, height, locale, scheme] of [
	[320, 844, 'en', 'light'],
	[390, 844, 'en', 'light'],
	[390, 844, 'fr', 'dark'],
	[768, 1024, 'en', 'light'],
	[1440, 900, 'en', 'light'],
	[1440, 900, 'fr', 'dark'],
] as const) {
	test(`Vehicle map preview at ${width}px in ${locale} and ${scheme}`, async ({ page }) => {
		await page.setViewportSize({ width, height });
		await page.emulateMedia({ colorScheme: scheme });
		await page.addInitScript((value) => localStorage.setItem('theme', value), scheme);
		await livePosition(page);
		const prefix = locale === 'fr' ? '/fr' : '';
		const shapes = page.waitForResponse((response) => scheduleMap.test(response.url()));
		await page.goto(prefix + path);
		const preview = page.locator(previewSlot);
		await preview.scrollIntoViewIfNeeded();
		await expect(preview).toHaveAttribute('data-ready', 'true');
		await expect(preview.locator('[data-slot="vehicle-overlay"]')).toBeVisible();
		await expect(preview.locator('.vehicle-map-stop-name')).toHaveCount(2);
		await expect(preview.locator('[data-slot="map-stage"]')).toBeVisible();
		await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
		expect((await shapes).ok()).toBe(true);
		expect(await preview.evaluate((node) => node.getBoundingClientRect().height)).toBe(256);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
			width,
		);
		if (width === 1440) {
			const departureLabel = page.locator('dt').filter({
				hasText: locale === 'fr' ? 'Départ prévu' : 'Scheduled departure',
			});
			await expect(departureLabel).toHaveCount(1);
			expect(
				await departureLabel.evaluate((node) => {
					const text = [...node.childNodes].find(
						(child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim(),
					);
					if (!text) return 0;
					const range = document.createRange();
					range.selectNodeContents(text);
					return [...range.getClientRects()].filter(({ width }) => width > 0).length;
				}),
			).toBe(1);
		}

		const artwork = process.env.TRANSIT_VEHICLE_MAP_ARTWORK;
		if (artwork) {
			await page.screenshot({
				path: join(artwork, `vehicle-live-stm-${locale}-${width}-${scheme}.png`),
				fullPage: true,
			});
		}

		const link = preview.locator('[data-slot="vehicle-map-link"]');
		const attribution = preview.locator(attributionButton);
		await expectSingleAttributionIcon(attribution);
		const target = (await attribution.boundingBox())!;
		expect(target.width).toBeGreaterThanOrEqual(44);
		expect(target.height).toBeGreaterThanOrEqual(44);
		if (width === 768) {
			await attribution.click();
			await expect(preview.locator('.maplibregl-ctrl-attrib')).toHaveAttribute('open', '');
			await attribution.click();
			await expect(preview.locator('.maplibregl-ctrl-attrib')).not.toHaveAttribute('open', '');
		}
		await page.unrouteAll({ behavior: 'wait' });
		await link.click({ position: { x: 64, y: 64 } });
		await expect(page).toHaveURL(
			(url) =>
				url.pathname === prefix + '/map' &&
				url.searchParams.get('provider') === 'stm' &&
				url.searchParams.get('selectedVehicle') === '40061' &&
				!url.searchParams.has('vehicle'),
		);
		if (width === 390 || width === 1440) {
			await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
			await expectSingleAttributionIcon(
				page.locator('[data-slot="map-stage"]:not(.map-preview)').locator(attributionButton),
			);
		}
	});
}

test('the vehicle map waits to enter the viewport and keeps a keyboard link without WebGL', async ({
	page,
}) => {
	await page.setViewportSize({ width: 320, height: 320 });
	await page.addInitScript(() => {
		const getContext = HTMLCanvasElement.prototype.getContext;
		Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
			value(this: HTMLCanvasElement, type: string, ...args: unknown[]) {
				return type.startsWith('webgl') ? null : Reflect.apply(getContext, this, [type, ...args]);
			},
		});
	});
	await livePosition(page);
	await page.goto('/fr' + path);
	const preview = page.locator(previewSlot);
	await expect(preview).toContainText('Chargement de la carte…');
	await expect(preview).not.toBeInViewport();
	await expect(preview.locator('[data-slot="map-stage"]')).toHaveCount(0);
	await expect(preview.getByRole('button')).toHaveCount(0);
	await preview.scrollIntoViewIfNeeded();
	await expect(preview).toContainText('La carte est indisponible.');
	await expect(preview.locator('[data-slot="vehicle-map-link"]')).toHaveCount(0);
	const link = page.getByRole('link', { name: 'Voir sur la carte', exact: true });
	await link.focus();
	await expect(link).toBeFocused();
	await page.unrouteAll({ behavior: 'wait' });
	await page.keyboard.press('Enter');
	await expect(page).toHaveURL(
		(url) =>
			url.pathname === '/fr/map' &&
			url.searchParams.get('provider') === 'stm' &&
			url.searchParams.get('selectedVehicle') === '40061' &&
			!url.searchParams.has('vehicle'),
	);
});

test('a dated vehicle record omits the live map', async ({ page }) => {
	await page.goto(
		'/vehicle/40061?provider=stm&frameMode=record&recordFrom=2026-11-08&recordTo=2026-11-14',
	);
	await expect(page.getByRole('article', { name: 'Days and hours in service' })).toBeVisible();
	await expect(page.locator(previewSlot)).toHaveCount(0);
});
