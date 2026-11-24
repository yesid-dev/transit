import { expect } from '@playwright/test';
import { test } from './layout-test';
import { recordMapFixture, recordMapPeriod } from './map-record-fixture';

for (const locale of ['en', 'fr'] as const) {
	for (const layer of ['stops', 'corridors', 'network'] as const) {
		test(`${locale} ${layer} legend and controls fit the map @layout`, async ({
			page,
			browserName,
			viewport,
		}, info) => {
			const fr = locale === 'fr';
			await recordMapFixture(page);
			await page.goto(
				`${fr ? '/fr' : ''}/map?${recordMapPeriod}&mapLayer=${layer === 'network' ? 'corridors' : layer}${layer === 'corridors' ? '&recordLine=24' : ''}`,
			);
			const group = page.getByRole('radiogroup', {
				name: fr ? 'Couches de la carte' : 'Map layers',
			});
			const legend = page.locator('[data-slot="record-map-legend"]');
			await expect(
				page.getByRole('searchbox', { name: fr ? /Trouver un/ : /Find a/ }),
			).toBeVisible();
			await expect(legend).toBeVisible();
			const map = page.getByRole('region').and(page.locator('[data-slot="map-stage"]'));
			const bounds = (await map.boundingBox())!;
			for (const control of [group, legend]) {
				const box = (await control.boundingBox())!;
				expect(box.x).toBeGreaterThanOrEqual(bounds.x - 1);
				expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
				expect(box.y + box.height).toBeLessThan(bounds.y + bounds.height);
			}
			const controls = (await group.locator('..').boundingBox())!;
			const heading = (await page.locator('.map-head').boundingBox())!;
			const chromeHeight =
				Math.max(controls.y + controls.height, heading.y + heading.height) -
				Math.min(controls.y, heading.y);
			expect(chromeHeight).toBeLessThan(bounds.height * 0.75);
			if (browserName === 'chromium' && (viewport?.width === 390 || viewport?.width === 1440)) {
				await expect
					.poll(() =>
						page.evaluate(() => {
							const probe = (
								window as Window & { __transitMap?: { loaded: boolean; moving: boolean } }
							).__transitMap;
							return probe?.loaded === true && !probe.moving;
						}),
					)
					.toBe(true);
				await page.screenshot({
					path: info.outputPath(
						`record-map-${layer}-${locale}-${viewport.width}-${info.project.use.colorScheme}.png`,
					),
				});
			}
		});
	}
}
