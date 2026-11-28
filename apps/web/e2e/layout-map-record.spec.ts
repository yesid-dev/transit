import { expect, type Locator, type Page } from '@playwright/test';
import { vectorStyleFromBasemap } from '../src/lib/components/map/basemap';
import { test } from './layout-test';
import { recordMapFixture, recordMapPeriod } from './map-record-fixture';
import { textDefects } from './layout-helpers';
import {
	closeMapControls,
	closeMapInView,
	expectAboveMapSource,
	openMapControls,
	openMapInView,
	openMapLegend,
} from './map-frame-controls';

interface OpeningMarks {
	zoom: number;
	aboveRoads: boolean;
	marks: { id: string; state: number; size: number }[];
}

async function readOpeningMarks(
	page: Page,
	layer: 'stops' | 'corridors',
): Promise<OpeningMarks | null> {
	return page.evaluate(
		(kind) => Reflect.get(window, '__transitMap')?.recordMarks(kind) ?? null,
		layer,
	);
}

for (const provider of ['stm', 'octranspo']) {
	test(`${provider} stops and corridors remain readable at opening zoom @layout`, async ({
		page,
	}, info) => {
		await recordMapFixture(page, true, provider);
		const query = new URLSearchParams(recordMapPeriod);
		query.set('provider', provider);
		for (const layer of ['stops', 'corridors'] as const) {
			query.set('mapLayer', layer);
			await page.goto(`/map?${query}`);
			await expect(page.getByTestId('map-progressive')).toHaveAttribute(
				'data-map-progressive-state',
				'ready',
			);
			await expect
				.poll(async () =>
					(await readOpeningMarks(page, layer))?.marks.some((mark) => mark.state === 3),
				)
				.toBe(true);
			const opening = (await readOpeningMarks(page, layer))!;
			expect(opening.zoom).toBeLessThan(13);
			expect(opening.aboveRoads).toBe(true);
			if (layer === 'stops') expect(opening.marks.some(({ id }) => id === 'MR2')).toBe(true);
			for (const mark of opening.marks.filter(({ state }) => state === 3)) {
				expect(mark.size).toBeGreaterThanOrEqual(layer === 'stops' ? 3.75 : 3.5);
			}
			await info.attach(`${layer}-opening-paint`, {
				body: JSON.stringify(opening),
				contentType: 'application/json',
			});
		}
	});
}

async function expectOutlineContrast(legend: Locator, theme: 'light' | 'dark') {
	const basemap = vectorStyleFromBasemap(
		{ url: 'fixture.pmtiles', attribution: '', generated_utc: '2026-11-21T00:00:00Z' },
		theme,
	);
	const backgrounds = basemap.layers.flatMap((layer) => {
		if (layer.id === 'earth' || layer.id === 'landuse-green') {
			return layer.type === 'fill' ? [String(layer.paint?.['fill-color'])] : [];
		}
		if (layer.id === 'water' && layer.type === 'line') return [String(layer.paint?.['line-color'])];
		return [];
	});
	expect(backgrounds).toHaveLength(3);
	const minimum = await legend.evaluate((legend, backgrounds) => {
		const sample = document.createElement('span');
		sample.style.color = 'var(--foreground)';
		legend.append(sample);
		const outline = getComputedStyle(sample).color;
		sample.remove();
		const canvas = document.createElement('canvas');
		canvas.width = canvas.height = 1;
		const context = canvas.getContext('2d', { willReadFrequently: true })!;
		function luminance(colour: string) {
			context.fillStyle = colour;
			context.fillRect(0, 0, 1, 1);
			const channels = context.getImageData(0, 0, 1, 1).data.slice(0, 3);
			return [...channels].reduce((luminance, channel, index) => {
				const value = channel / 255;
				const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
				return luminance + linear * [0.2126, 0.7152, 0.0722][index]!;
			}, 0);
		}
		const ink = luminance(outline);
		return Math.min(
			...backgrounds.map((background) => {
				const base = luminance(background);
				return (Math.max(base, ink) + 0.05) / (Math.min(base, ink) + 0.05);
			}),
		);
	}, backgrounds);
	expect(minimum).toBeGreaterThanOrEqual(3);
	return minimum;
}

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
	test(`Ottawa ${locale} Record map panels clear the source strip @layout`, async ({
		page,
		viewport,
	}) => {
		await recordMapFixture(page, true, 'octranspo');
		await page.goto(
			`${locale === 'fr' ? '/fr' : ''}/map?${recordMapPeriod.replace('stm', 'octranspo')}&mapLayer=stops`,
		);
		if (viewport!.width < 1024) {
			await openMapInView(page);
			await expect(
				page.getByRole('searchbox', { name: locale === 'fr' ? 'Trouver un arrêt' : 'Find a stop' }),
			).toBeVisible();
			return;
		}
		for (const width of [1440, 1280, 1024]) {
			await page.setViewportSize({ width, height: viewport!.height });
			await expectAboveMapSource(page, page.locator('[data-slot="map-details"]'));
			await expectAboveMapSource(
				page,
				page.locator('[data-frame-controls="desktop"]').locator('xpath=ancestor::aside'),
			);
		}
	});
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
			const legendSelector = `[data-map-legend="${phone ? 'phone' : 'desktop'}"]`;
			const legend = page.locator(legendSelector);
			const assertWithinMap = async (control: typeof legend) => {
				const bounds = (await page.locator('.map-surface').boundingBox())!;
				const box = (await control.boundingBox())!;
				expect(box.x).toBeGreaterThanOrEqual(bounds.x - 1);
				expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
				expect(box.y).toBeGreaterThanOrEqual(bounds.y);
				expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
			};
			if (phone) await openMapLegend(page);
			await expect(legend).toBeVisible();
			const phoneSheet = page.locator('[data-map-in-view-sheet]');
			await assertWithinMap(phone ? phoneSheet : legend);
			for (const width of viewport!.width === 390 ? [320, 390] : [viewport!.width]) {
				await page.setViewportSize({ width, height: viewport!.height });
				await expect(legend).toBeVisible();
				const defects = await textDefects(page, legendSelector);
				expect(
					defects.filter(({ kind }) => kind === 'broken-word'),
					`${width}px legend`,
				).toEqual([]);
				await expectUnbrokenWords(legend, `${width}px at 100%`);
			}
			const theme = info.project.use.colorScheme === 'dark' ? 'dark' : 'light';
			const swatches = legend.locator('ol > li > [aria-hidden="true"]');
			await expect(swatches).toHaveCount(5);
			for (const [level, swatch] of (await swatches.all()).entries()) {
				await expect(swatch).toHaveCSS(
					'background-color',
					await swatch.evaluate((node, step) => {
						const sample = document.createElement('span');
						sample.style.backgroundColor = `var(--transit-good-to-bad-${step})`;
						node.parentElement!.append(sample);
						const fill = getComputedStyle(sample).backgroundColor;
						sample.remove();
						return fill;
					}, level),
				);
			}
			const minimum = await expectOutlineContrast(legend, theme);
			await info.attach('basemap-contrast', {
				body: minimum.toFixed(2),
				contentType: 'text/plain',
			});
			if (phone) {
				await expect(page.locator('[data-slot="map-source-footer"]')).toBeHidden();
			} else {
				await expectAboveMapSource(page, page.locator('[data-slot="map-details"]'));
				await expectAboveMapSource(
					page,
					page.locator('[data-frame-controls="desktop"]').locator('xpath=ancestor::aside'),
				);
			}
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
				const sheet = page.locator('[data-map-in-view-sheet]');
				await expect(legend.getByText(title, { exact: true })).toBeVisible();
				for (const zoom of ['100%', '200%']) {
					await page.evaluate((size) => (document.documentElement.style.fontSize = size), zoom);
					await expectUnbrokenWords(legend, zoom);
					await states.scrollIntoViewIfNeeded();
					const marks = states.locator('svg');
					await expect(marks).toHaveCount(4);
					for (const [index, dash] of ['6 3', '2 3.6', '10 6', '1 3'].entries()) {
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
			const layerChoice = page.getByRole('radiogroup', { name: fr ? 'Couche' : 'Layer' });
			await layerChoice.scrollIntoViewIfNeeded();
			await assertWithinMap(layerChoice);
			await closeMapControls(page);
			await assertWithinMap(
				page.locator(phone ? '[data-slot="map-mobile-peek"]' : '.map-head:visible'),
			);
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
			if (!phone) {
				for (const width of [1280, 1024]) {
					await page.setViewportSize({ width, height: viewport?.height ?? 900 });
					await expectAboveMapSource(page, page.locator('[data-slot="map-details"]'));
					await expectAboveMapSource(
						page,
						page.locator('[data-frame-controls="desktop"]').locator('xpath=ancestor::aside'),
					);
				}
			}
		});
	}
}
