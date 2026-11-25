import { expect } from '@playwright/test';
import { test } from './layout-test';

for (const locale of ['en', 'fr']) {
	test(`${locale} map chrome leaves room for the map and text enlargement @layout`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
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
		expect((await measure()).share).toBeLessThanOrEqual(0.25);
		await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
		await expect.poll(measure).toMatchObject({ overlap: false, clipped: false });
	});

	test(`${locale} desktop legend fits and explains four delay statuses @layout`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
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
		expect(geometry.bottom).toBeLessThanOrEqual(900);
		expect(geometry.clipped).toBe(false);
		expect(new Set(geometry.track).size).toBe(1);
	});
}
