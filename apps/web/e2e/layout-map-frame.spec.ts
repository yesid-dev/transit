import { expect } from '@playwright/test';
import { test } from './layout-test';
import { mapChromeShareBudget, mapOpenLegendViewportHeight } from './design-pass-debt';
import { captureFixture, captureUrl, captureVehicle } from './capture-fixture';
import { closeMapControls, openMapControls } from './map-frame-controls';

for (const locale of ['en', 'fr']) {
	test(`${locale} map chrome leaves room for the map and text enlargement @layout`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.clock.setFixedTime(Date.parse('2026-06-15T12:00:20Z'));
		await page.goto(`${locale === 'fr' ? '/fr' : ''}/map?provider=stm`);
		await expect(page.getByTestId('map-progressive')).toHaveAttribute(
			'data-map-progressive-state',
			'ready',
		);
		await expect(page.locator('h1')).toHaveCount(1);
		const measure = () =>
			page.evaluate(() => {
				const selectors = [
					'.map-mobile-head',
					'.map-in-view-button',
					'.map-camera-actions',
					'[data-slot="surface-rail-mobile"] button',
					'[data-slot="map-legend-fab"] button',
				];
				const map = document.querySelector('[data-slot="map-frame"]')!.getBoundingClientRect();
				const boxes = selectors.flatMap((selector) =>
					[...document.querySelectorAll<HTMLElement>(selector)].flatMap((element) => {
						const { left, right, top, bottom, width, height } = element.getBoundingClientRect();
						return width && height
							? [
									{
										left,
										right,
										top,
										bottom,
										width,
										height,
										clipped: element.scrollWidth > element.clientWidth + 1,
									},
								]
							: [];
					}),
				);
				return {
					share:
						boxes.reduce((area, box) => area + box.width * box.height, 0) /
						(map.width * map.height),
					overlap: boxes.some((a, i) =>
						boxes
							.slice(i + 1)
							.some(
								(b) =>
									a.left < b.right - 1 &&
									a.right > b.left + 1 &&
									a.top < b.bottom - 1 &&
									a.bottom > b.top + 1,
							),
					),
					clipped: boxes.some(
						(box) =>
							box.clipped ||
							box.left < 0 ||
							box.right > innerWidth ||
							box.top < 0 ||
							box.bottom > innerHeight + 1,
					),
				};
			});
		expect((await measure()).share).toBeLessThanOrEqual(mapChromeShareBudget);
		await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
		await expect.poll(measure).toMatchObject({ overlap: false, clipped: false });
	});

	test(`${locale} desktop legend fits and explains four delay statuses @layout`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: mapOpenLegendViewportHeight });
		await page.goto(`${locale === 'fr' ? '/fr' : ''}/map?provider=stm`);
		const legend = page.locator('[data-map-legend="desktop"]');
		await expect(legend).toBeVisible();
		const group = legend.getByRole('list', {
			name:
				locale === 'fr'
					? 'Véhicules, selon le retard au dernier signalement'
					: 'Vehicles, by their delay at the last report',
		});
		await expect(group.getByRole('listitem')).toHaveCount(4);
		const geometry = await legend.evaluate((root) => {
			const rows = [...root.querySelectorAll('ul > li')];
			return {
				bottom: root.getBoundingClientRect().bottom,
				track: rows.map((row) => row.lastElementChild!.getBoundingClientRect().left),
				clipped: root.scrollHeight > root.clientHeight + 1,
			};
		});
		expect(geometry.bottom).toBeLessThanOrEqual(mapOpenLegendViewportHeight);
		expect(geometry.clipped).toBe(false);
		expect(new Set(geometry.track).size).toBe(1);
	});

	test(`${locale} crowding legend orders the five levels under their swatches @layout`, async ({
		page,
	}) => {
		const fr = locale === 'fr';
		const phone = page.viewportSize()!.width < 1024;
		const at = Date.parse('2026-11-23T16:00:00Z');
		await page.clock.setFixedTime(at);
		await page.route(captureUrl, (route) =>
			route.fulfill({
				json: captureFixture(at, { vehicle_positions: [captureVehicle(at, { occupancy: 0 })] }),
			}),
		);
		await page.goto(`${fr ? '/fr' : ''}/map?provider=stm`);
		await openMapControls(page);
		await page.locator('[data-map-filter-trigger]').click();
		const crowding = page.locator('[data-filter-group="crowding"]');
		await crowding.getByRole('checkbox', { name: fr ? 'Vide' : 'Empty', exact: true }).click();
		await closeMapControls(page);
		if (phone) await page.getByTestId('map-legend-button').click();
		const legend = page.locator(
			phone ? '[data-map-legend="phone"]' : '[data-map-legend="desktop"]',
		);
		const ramp = legend.getByRole('list', { name: fr ? 'Places à bord' : 'Room on board' });
		await expect(ramp).toBeVisible();
		await expect(ramp.getByRole('listitem')).toHaveText(
			fr
				? ['Vide', 'Plusieurs places', 'Peu de places', 'Debout', 'Plein']
				: ['Empty', 'Many seats', 'Few seats', 'Standing', 'Full'],
		);
		const colours = await ramp
			.locator('li > [aria-hidden="true"]')
			.evaluateAll((swatches) =>
				swatches.map((swatch) => getComputedStyle(swatch).backgroundColor),
			);
		expect(new Set(colours).size).toBe(5);
	});
}
