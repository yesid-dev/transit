import { expect } from '@playwright/test';
import { test } from './layout-test';
import { recordMapFixture, recordMapPeriod } from './map-record-fixture';
import {
	closeMapControls,
	closeMapInView,
	openMapControls,
	openMapInView,
} from './map-frame-controls';

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
			await openMapInView(page);
			await expect(
				page.getByRole('searchbox', { name: fr ? /Trouver un/ : /Find a/ }),
			).toBeVisible();
			await closeMapInView(page);
			const phone = page.viewportSize()!.width < 1024;
			const legend = page.locator(
				phone ? '[data-map-legend="phone"]' : '[data-map-legend="desktop"]',
			);
			const assertWithinMap = async (control: typeof legend) => {
				const bounds = (await page.locator('.map-surface').boundingBox())!;
				const box = (await control.boundingBox())!;
				expect(box.x).toBeGreaterThanOrEqual(bounds.x - 1);
				expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
				expect(box.y).toBeGreaterThanOrEqual(bounds.y);
				expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
			};
			if (phone) await page.getByTestId('map-legend-button').click();
			await expect(legend).toBeVisible();
			await assertWithinMap(legend);
			if (layer === 'network' && viewport?.width === 390) {
				const title = fr ? 'Temps perdu entre deux arrêts' : 'Time lost between two stops';
				const states = legend.getByRole('list', { name: title, exact: true }).filter({
					hasText: fr ? 'Trop peu pour juger' : 'Too few to judge',
				});
				const sheet = page.locator('[data-slot="map-legend-sheet"]');
				await expect(legend.getByText(title, { exact: true })).toBeVisible();
				for (const zoom of ['100%', '200%']) {
					await page.evaluate((size) => (document.documentElement.style.fontSize = size), zoom);
					await states.scrollIntoViewIfNeeded();
					const marks = states.locator('svg');
					await expect(marks).toHaveCount(3);
					for (const [index, dash] of ['6 3', '2 3.6', '10 6'].entries()) {
						const mark = marks.nth(index);
						await mark.scrollIntoViewIfNeeded();
						await expect(mark.locator('line')).toHaveAttribute('stroke-dasharray', dash);
						await expect(mark.locator('line')).toHaveAttribute('stroke-width', '2');
						const box = (await mark.boundingBox())!;
						const frame = (await sheet.boundingBox())!;
						expect(box.x).toBeGreaterThanOrEqual(frame.x);
						expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width);
						expect(box.y).toBeGreaterThanOrEqual(frame.y);
						expect(box.y + box.height).toBeLessThanOrEqual(frame.y + frame.height);
					}
				}
				await page.evaluate(() => document.documentElement.style.removeProperty('font-size'));
			}
			if (phone) await page.keyboard.press('Escape');
			await openMapControls(page);
			await assertWithinMap(page.getByRole('radiogroup', { name: fr ? 'Couche' : 'Layer' }));
			await closeMapControls(page);
			await assertWithinMap(page.locator('.map-head:visible'));
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
