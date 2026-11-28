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

const ottawa = [
	{ id: 'MR1', name: 'Rideau', lat: 45.425, lon: -75.69, routes: ['24'] },
	{ id: 'MR2', name: 'Waller', lat: 45.426, lon: -75.685, routes: ['24'] },
	{ id: 'MR3', name: 'Laurier', lat: 45.422, lon: -75.683, routes: ['24'] },
	{ id: 'MR4', name: 'Somerset', lat: 45.417, lon: -75.688, routes: ['24'] },
	{ id: 'MR5', name: 'Gladstone', lat: 45.412, lon: -75.691, routes: ['24'] },
];

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
			await recordMapFixture(page, true, provider, provider === 'octranspo' ? ottawa : undefined);
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
				await expect(page.locator('[data-map-legend]:visible')).toContainText(
					fr ? 'Au-dessus de l’échelle : hauteur limitée' : 'Taller than the scale: capped',
				);
				if (phone) await closeMapInView(page);
				else {
					await toggle.press('Enter');
					await expect(toggle).toHaveAttribute('aria-checked', 'false');
					await expect.poll(async () => (await readRecordRender(page))?.pitch).toBe(0);
				}
			}
		});
	}
}
