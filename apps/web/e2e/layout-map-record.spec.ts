import { expect, type Locator } from '@playwright/test';
import { test } from './layout-test';
import { recordMapFixture, recordMapPeriod } from './map-record-fixture';
import {
	closeMapControls,
	closeMapInView,
	openMapControls,
	openMapInView,
} from './map-frame-controls';

async function expectUnbrokenWords(legend: Locator, textSize: string) {
	const result = await legend.evaluate((root) => {
		const words: string[] = [];
		const broken: string[] = [];
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		const range = document.createRange();
		while (walker.nextNode()) {
			const node = walker.currentNode;
			const parent = node.parentElement;
			if (!parent || parent.closest('[aria-hidden="true"]')) continue;
			const bounds = parent.getBoundingClientRect();
			for (const match of node.textContent!.matchAll(/[^ \t\r\n\f]+/gu)) {
				const word = match[0];
				range.setStart(node, match.index);
				range.setEnd(node, match.index + word.length);
				const boxes = [...range.getClientRects()].filter((box) => box.width > 0);
				words.push(word);
				if (
					boxes.length !== 1 ||
					boxes.some((box) => box.left < bounds.left - 1 || box.right > bounds.right + 1)
				)
					broken.push(word);
			}
		}
		return { count: words.length, broken };
	});
	expect(result.count).toBeGreaterThan(0);
	expect(result.broken, `Legend words broken or overflowing at ${textSize}`).toEqual([]);
}

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
			await expectUnbrokenWords(legend, '100%');
			if (layer !== 'stops') {
				const labels = (await legend.locator('ol > li').allTextContents()).map((label) =>
					label.trim(),
				);
				expect(labels).toEqual(
					fr
						? [
								'Aucun temps perdu',
								'Moins de 30\u00a0s',
								'30 à moins de 60\u00a0s',
								'1 à moins de 2\u00a0min',
								'2\u00a0min et plus',
							]
						: [
								'No time lost',
								'Under 30\u00a0s',
								'30 to under 60\u00a0s',
								'1 to under 2\u00a0min',
								'2\u00a0min and over',
							],
				);
			}
			if (layer === 'network' && viewport?.width === 390) {
				const title = fr ? 'Temps perdu entre deux arrêts' : 'Time lost between two stops';
				const states = legend.getByRole('list', { name: title, exact: true }).filter({
					hasText: fr ? 'Trop peu pour juger' : 'Too few to judge',
				});
				const sheet = page.locator('[data-slot="map-legend-sheet"]');
				await expect(legend.getByText(title, { exact: true })).toBeVisible();
				for (const zoom of ['100%', '200%']) {
					await page.evaluate((size) => (document.documentElement.style.fontSize = size), zoom);
					await expectUnbrokenWords(legend, zoom);
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
