import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';
import {
	closeMapControls,
	closeMapInView,
	openMapControls,
	openMapInView,
	openMapLegend,
} from './map-frame-controls';
import { recordMapFixture, recordMapPeriod } from './map-record-fixture';

interface RecordRender {
	pitch: number;
	raisedCorridors: { height: number }[];
}

function readRecordRender(page: Page): Promise<RecordRender | null> {
	return page.locator('[data-map-runtime]').evaluate((element) => {
		const inspect = Reflect.get(element, Symbol.for('transit.map.renderReceipt'));
		return typeof inspect === 'function' ? inspect() : null;
	});
}

for (const provider of ['stm', 'octranspo']) {
	for (const locale of ['en', 'fr'] as const) {
		test(`${provider} ${locale} raises the same Record readings with a keyboard switch @theme`, async ({
			page,
		}, info) => {
			const fr = locale === 'fr';
			await page.emulateMedia({ reducedMotion: 'reduce' });
			await recordMapFixture(page, true, provider);
			const params = new URLSearchParams(recordMapPeriod);
			params.set('provider', provider);
			params.set('mapLayer', 'corridors');
			params.set('recordLine', '24');
			const reading = page.getByRole('region', { name: /^0[.,]7\s+min\b/u });
			const switchName = fr ? 'Vue 3D' : '3D view';

			for (const width of [390, 1440]) {
				const phone = width < 1024;
				await page.setViewportSize({ width, height: phone ? 844 : 900 });
				await page.goto(`${fr ? '/fr' : ''}/map?${params}`);
				await openMapInView(page);
				await expect(reading).toBeVisible();
				if (phone) await closeMapInView(page);
				await openMapControls(page);
				const toggle = page.getByRole('switch', { name: switchName });
				await expect(toggle).toHaveAttribute('aria-checked', 'false');
				await expect.poll(async () => (await readRecordRender(page))?.pitch).toBe(0);
				await expect
					.poll(async () => (await readRecordRender(page))?.raisedCorridors.length)
					.toBe(0);

				await toggle.press('Space');
				await expect(toggle).toBeFocused();
				await expect(toggle).toHaveAttribute('aria-checked', 'true');
				await expect.poll(async () => (await readRecordRender(page))?.pitch).toBe(50);
				await expect
					.poll(async () =>
						(await readRecordRender(page))?.raisedCorridors.some(({ height }) => height > 0),
					)
					.toBe(true);
				if (phone) await closeMapControls(page);

				const evidence = process.env.TRANSIT_K3_PICTURES;
				if (evidence)
					await page.screenshot({
						path: join(evidence, `${provider}-${locale}-${width}-${info.project.name}.png`),
						animations: 'disabled',
					});
				await openMapInView(page);
				await expect(reading).toBeVisible();
				if (phone) {
					await closeMapInView(page);
					await openMapLegend(page);
				}
				const legend = page.locator('[data-map-legend]:visible');
				await expect(legend).toContainText(
					fr ? 'Au-dessus de l’échelle : hauteur limitée' : 'Taller than the scale: capped',
				);
				if (phone) await closeMapInView(page);
				else {
					const cap = await legend.evaluate((element) => {
						const cap = element.querySelector('[data-corridor-cap-swatch]')!;
						const steps = [...element.querySelectorAll('ol > li > [aria-hidden="true"]')];
						const canvas = document.createElement('canvas');
						const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
						function luminance(swatch: Element) {
							ctx.fillStyle = getComputedStyle(swatch).backgroundColor;
							ctx.fillRect(0, 0, 1, 1);
							return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)].reduce(
								(sum, channel, index) => {
									const value = channel / 255;
									const linear =
										value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
									return sum + linear * [0.2126, 0.7152, 0.0722][index]!;
								},
								0,
							);
						}
						const capLight = luminance(cap);
						return {
							followsScale: Boolean(
								steps.at(-1)!.compareDocumentPosition(cap) & Node.DOCUMENT_POSITION_FOLLOWING,
							),
							ratios: steps.map((swatch) => {
								const light = luminance(swatch);
								return (Math.max(light, capLight) + 0.05) / (Math.min(light, capLight) + 0.05);
							}),
						};
					});
					expect(cap.followsScale).toBe(true);
					expect(Math.min(...cap.ratios)).toBeGreaterThanOrEqual(3);
					const [legendBounds, railBounds] = await Promise.all([
						legend.boundingBox(),
						page.locator('.map-rail.desktop').boundingBox(),
					]);
					expect(legendBounds!.y + legendBounds!.height).toBeLessThanOrEqual(
						railBounds!.y + railBounds!.height + 1,
					);
					await toggle.press('Enter');
					await expect(toggle).toHaveAttribute('aria-checked', 'false');
					await expect.poll(async () => (await readRecordRender(page))?.pitch).toBe(0);
				}
			}
		});
	}
}
