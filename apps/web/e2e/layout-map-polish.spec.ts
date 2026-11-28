import { expectAboveMapSource, openMapControls } from './map-frame-controls';
import { waitForStableHeader } from './layout-header-settle';
import { test } from './layout-test';
import { expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureTrip, captureTripReport } from './capture-fixture';

test.describe.configure({ mode: 'parallel' });

const epoch = Date.parse(
	JSON.parse(readFileSync(new URL('./departures.json', import.meta.url), 'utf8')).generated_utc,
);

async function headerOverlaps(page: Page) {
	return page.getByTestId('nav-pill').evaluate((nav) => {
		const search = nav.querySelector('input[type="search"]');
		if (!search?.checkVisibility()) return [];
		const box = search.getBoundingClientRect();
		return [...nav.querySelectorAll('.nav-wordmark, [data-slot="product-brand"], .nav-links a')]
			.filter((el) => el.checkVisibility())
			.filter((el) => {
				const r = el.getBoundingClientRect();
				return (
					Math.min(r.right, box.right) - Math.max(r.left, box.left) > 1 &&
					Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top) > 1
				);
			})
			.map((el) => el.textContent);
	});
}

for (const provider of ['stm', 'octranspo'])
	for (const locale of ['en', 'fr'])
		for (const active of [false, true]) {
			test(`${provider} ${locale} ${active ? 'active' : 'clear'} settled map panel polish @layout`, async ({
				page,
				browserName,
			}, info) => {
				await page.clock.setFixedTime(epoch + 900000);
				await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
				await page.route('**/v1/**', async (route) => {
					const url = new URL(route.request().url());
					url.pathname = '/__layout/stale' + url.pathname;
					await route.fulfill({ response: await route.fetch({ url: url.href }) });
				});
				const widths = page.viewportSize()!.width < 1024 ? [390] : [1440, 1280];
				for (const width of widths) {
					await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
					await page.emulateMedia({ reducedMotion: 'no-preference' });
					await page.goto(
						`${locale === 'fr' ? '/fr' : ''}/map?provider=${provider}${active ? '&route=24&vehicle=layout-bus' : ''}`,
						{ waitUntil: 'networkidle' },
					);
					await waitForStableHeader(page);
					expect(await headerOverlaps(page), 'header after fonts load').toEqual([]);
					await page.emulateMedia({ reducedMotion: 'reduce' });
					await openMapControls(page);
					await page.locator('[data-map-filter-trigger]').click();
					const panel = page.locator('.map-filters:visible');
					const removeLine = panel.getByRole('button', {
						name:
							locale === 'fr' ? /^Retirer la ligne 24(?:, .+)?$/u : /^Remove line 24(?:, .+)?$/u,
					});
					const sw = panel.getByRole('switch', {
						name: locale === 'fr' ? 'Positions estimées' : 'Estimated positions',
						exact: true,
					});
					await expect(sw).toBeDisabled();
					if (width >= 1024) {
						await expectAboveMapSource(page, page.locator('[data-slot="map-details"]'));
						await expectAboveMapSource(
							page,
							page.locator('[data-frame-controls="desktop"]').locator('xpath=ancestor::aside'),
						);
					} else {
						const sheet = page.locator('[data-map-in-view-sheet]');
						await expect(
							sheet.getByRole('tab', { name: locale === 'fr' ? 'Options' : 'Controls' }),
						).toHaveAttribute('aria-selected', 'true');
						await expect(page.locator('[data-slot="map-source-footer"]')).toBeHidden();
						const box = (await sheet.boundingBox())!;
						const viewport = page.viewportSize()!;
						expect(box.x).toBeGreaterThanOrEqual(0);
						expect(box.y).toBeGreaterThanOrEqual(0);
						expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
						expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
					}
					const heading = panel.getByRole('heading', { name: 'Positions' });
					const h = (await heading.boundingBox())!;
					const row = (await sw.boundingBox())!;
					expect(row.y).toBeGreaterThanOrEqual(h.y + h.height);
					expect(Math.abs(row.x - h.x)).toBeLessThan(1);
					const label = await sw.locator('.map-motion-state').evaluate((el) => ({
						height: el.getBoundingClientRect().height,
						line: parseFloat(getComputedStyle(el).lineHeight),
					}));
					expect(label.height).toBeLessThanOrEqual(label.line + 1);
					if (active) {
						await expect(removeLine).toBeVisible();
						const target = (await removeLine.boundingBox())!;
						expect(target.height).toBeGreaterThanOrEqual(44);
						expect(target.width).toBeGreaterThanOrEqual(44);
						await expect(removeLine).toContainText('×');
					}
					expect(
						(
							await new AxeBuilder({ page })
								.include('.map-filters')
								.include('[data-testid="nav-pill"]')
								.analyze()
						).violations,
					).toEqual([]);
					await waitForStableHeader(page);
					if (process.env.TRANSIT_POLISH_SHOTS) {
						const dir = fileURLToPath(
							new URL('../../../.cache/cohesion/after/controls', import.meta.url),
						);
						mkdirSync(dir, { recursive: true });
						await page.screenshot({
							path: resolve(
								dir,
								`${browserName}-${provider}-${locale}-${width}-${active ? 'active' : 'clear'}-${info.project.use.colorScheme}.png`,
							),
							animations: 'disabled',
						});
						if (active) {
							await removeLine.scrollIntoViewIfNeeded();
							await page.screenshot({
								path: resolve(
									dir,
									`${browserName}-${provider}-${locale}-${width}-active-filters-${info.project.use.colorScheme}.png`,
								),
								animations: 'disabled',
							});
						}
					}
					if (active) {
						await removeLine.click();
						await expect(page).not.toHaveURL(/[?&]route=24(?:&|$)/);
					}
				}
			});
		}

test('opening vehicle details keeps the global map report timestamp @layout', async ({ page }) => {
	await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
	await page.clock.setFixedTime(epoch + 30_000);
	await page.route('**/v1/**', async (route) => {
		const url = new URL(route.request().url());
		url.pathname = '/__layout/fresh' + url.pathname;
		await route.fulfill({ response: await route.fetch({ url: url.href }) });
	});
	const tripScope = '**/api/live-trips?city=stm&trip=T1';
	await page.route(tripScope, (route) =>
		route.fulfill({
			json: captureTripReport('stm', new Date(epoch - 3600_000).toISOString(), [
				captureTrip('T1', '24', []),
			]),
		}),
	);
	await page.goto('/map', { waitUntil: 'networkidle' });

	const timestamp = page.locator('[data-slot="map-frame"] [data-slot="freshness-stamp"] time');
	await expect(timestamp).toHaveAttribute('datetime', /.+/);
	const original = await timestamp.getAttribute('datetime');
	await page.goto('/map?provider=stm&focus=vehicle:layout-bus', { waitUntil: 'networkidle' });
	await expect
		.poll(() =>
			page.evaluate(() => {
				const probe = (window as unknown as { __transitMap?: { loaded: boolean; moving: boolean } })
					.__transitMap;
				return Boolean(probe?.loaded && !probe.moving);
			}),
		)
		.toBe(true);
	const point = await page.evaluate(() =>
		(
			window as unknown as { __transitMap: { project(point: number[]): { x: number; y: number } } }
		).__transitMap.project([-73.59, 45.51]),
	);
	const trips = page.waitForResponse(tripScope);
	await page.locator('.maplibregl-canvas').click({ position: point });
	await trips;
	await expect(timestamp).toHaveAttribute('datetime', original!);
});
