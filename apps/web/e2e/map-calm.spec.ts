import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { captureFixture, captureUrl, captureVehicle } from './capture-fixture';
import {
	closeMapInView,
	mapControlsPill,
	openMapInView,
	openMapLegend,
} from './map-frame-controls';
import { recordMapFixture, recordMapPeriod } from './map-record-fixture';

function holdResponse(page: Page, url: string | RegExp) {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	return {
		release,
		route: page.route(url, async (route) => {
			await gate;
			await route.fallback();
		}),
	};
}

for (const record of [false, true]) {
	test(`${record ? 'Record' : 'Live'} controls wait for the map and first reading`, async ({
		page,
	}, testInfo) => {
		const phone = page.viewportSize()!.width < 1024;
		const viewport = phone ? { width: 390, height: 844 } : { width: 1440, height: 900 };
		await page.setViewportSize(viewport);
		const fr = record;
		const dark = fr;
		const provider = phone && !fr ? 'octranspo' : 'stm';
		await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
		await page.addInitScript(
			(theme) => localStorage.setItem('theme', theme),
			dark ? 'dark' : 'light',
		);
		if (record) await recordMapFixture(page);
		const reading = holdResponse(page, record ? '**/api/map-record?**' : captureUrl);
		await reading.route;

		const progressive = page.getByTestId('map-progressive');
		const poster = page.getByTestId('map-progressive-poster');
		const controls = phone ? mapControlsPill(page) : page.locator('.map-rail.desktop');
		const zoom = page.getByRole('button', { name: fr ? 'Zoom avant' : 'Zoom in' });
		const evidenceDir = process.env.TRANSIT_MAP_CALM_PICTURES;
		const evidence = `map-${record ? 'record' : 'live'}-${provider}-${viewport.width}-${fr ? 'fr' : 'en'}-${dark ? 'dark' : 'light'}`;

		try {
			await page.goto(record ? `/fr/map?${recordMapPeriod}` : `/map?provider=${provider}`);
			await expect(progressive).toHaveAttribute('data-map-idle-time', /\d/);
			await expect(progressive).toHaveAttribute('data-map-progressive-state', 'booting');
			await expect(poster).toBeVisible();
			await expect(controls).toBeHidden();
			await expect(zoom).toHaveCount(0);
			const canvas = page.locator('.maplibregl-canvas');
			await canvas.evaluate((element: HTMLCanvasElement) => element.focus());
			await expect(canvas).not.toBeFocused();
			const posterBounds = await progressive.boundingBox();
			if (evidenceDir && ['phone', 'desktop'].includes(testInfo.project.name))
				await page.screenshot({ path: join(evidenceDir, `${evidence}-loading.png`) });

			reading.release();
			await expect(progressive).toHaveAttribute('data-map-progressive-state', 'ready');
			await expect(controls).toBeVisible();
			await expect(zoom).toBeEnabled();
			await zoom.focus();
			await expect(zoom).toBeFocused();
			await page.keyboard.press('Tab');
			await expect(
				page.getByRole('button', { name: fr ? 'Zoom arrière' : 'Zoom out' }),
			).toBeFocused();
			expect(await progressive.boundingBox()).toEqual(posterBounds);
			if (evidenceDir && ['phone', 'desktop'].includes(testInfo.project.name))
				await page.screenshot({ path: join(evidenceDir, `${evidence}-ready.png`) });
		} finally {
			reading.release();
		}
	});
}

test('Live map draws its first vehicle reading while stops and timetable are pending', async ({
	page,
}) => {
	const now = Date.now();
	await page.route(captureUrl, (route) =>
		route.fulfill({
			json: captureFixture(now, { vehicle_positions: [captureVehicle(now)] }),
		}),
	);
	const stopsUrl = '**/api/stops/slim?**';
	const timetableUrl = '**/api/schedule-edition?**';
	const stops = holdResponse(page, stopsUrl);
	const timetable = holdResponse(page, timetableUrl);
	await Promise.all([stops.route, timetable.route]);

	try {
		await Promise.all([
			page.waitForRequest(stopsUrl),
			page.waitForRequest(timetableUrl),
			page.goto('/map?provider=stm'),
		]);
		await expect(page.getByTestId('map-progressive')).toHaveAttribute(
			'data-map-progressive-state',
			'ready',
		);
		await expect(page.locator('[data-motion-vehicle-count="1"]')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Zoom in' })).toBeEnabled();
	} finally {
		stops.release();
		timetable.release();
	}
});

async function expectQuietClick(page: Page, target: Locator) {
	await target.click();
	await expect(page.locator('.global-ripple')).toHaveCount(0);
}

test('the header, cards, charts and map do not start a click ripple', async ({ page }) => {
	const phone = page.viewportSize()!.width < 1024;
	await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1440, height: 900 });
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await page.goto('/map?provider=stm');
	const menu = page.getByRole('button', { name: 'Open menu', exact: true });
	await expect(page.locator('html[data-hydrated]')).toBeAttached();
	await menu.click();
	await expect(page.locator('.global-ripple')).toHaveCount(0);
	await page.keyboard.press('Escape');
	await expect(page.locator('.global-ripple')).toHaveCount(0);

	await expect(page.getByTestId('map-progressive')).toHaveAttribute(
		'data-map-progressive-state',
		'ready',
	);
	await expectQuietClick(page, page.locator('.maplibregl-canvas'));
	await openMapInView(page);
	await expectQuietClick(page, page.locator('[data-map-in-view-title]'));
	if (phone) await openMapLegend(page);
	await expectQuietClick(page, page.locator(`[data-map-legend="${phone ? 'phone' : 'desktop'}"]`));
	if (phone) await closeMapInView(page);

	await page.goto(
		'/network?provider=stm&frameMode=record&recordFrom=2026-11-20&recordTo=2026-11-22',
	);
	const chart = page.locator('[data-slot="chart-frame"]').first();
	await expect(chart).toBeVisible();
	await expectQuietClick(page, page.locator('main [data-slot="record-card"] h2').first());
	await expectQuietClick(page, chart);
});
