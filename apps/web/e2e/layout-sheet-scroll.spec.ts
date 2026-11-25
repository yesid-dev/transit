import { test } from './layout-test';
import { expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const epoch = Date.parse(
	JSON.parse(readFileSync(new URL('./departures.json', import.meta.url), 'utf8')).generated_utc,
);

for (const locale of ['en', 'fr'])
	for (const viewport of [
		{ width: 844, height: 390 },
		{ width: 390, height: 844 },
	])
		test(`${locale} ${viewport.width} sheet scrolls within detents @layout`, async ({ page }) => {
			await page.setViewportSize(viewport);
			await page.clock.setFixedTime(epoch + 30_000);
			await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
			await page.route('**/v1/**', async (route) => {
				const url = new URL(route.request().url());
				url.pathname = '/__layout/fresh' + url.pathname;
				await route.fulfill({ response: await route.fetch({ url: url.href }) });
			});
			await page.goto(`${locale === 'fr' ? '/fr' : ''}/map?provider=stm&focus=vehicle:layout-bus`, {
				waitUntil: 'networkidle',
			});
			await expect
				.poll(() =>
					page.evaluate(() =>
						Boolean(
							(window as unknown as { __transitMap?: { loaded: boolean } }).__transitMap?.loaded,
						),
					),
				)
				.toBe(true);
			const point = await page.evaluate(() =>
				(
					window as unknown as { __transitMap: { project(c: number[]): { x: number; y: number } } }
				).__transitMap.project([-73.59, 45.51]),
			);
			await page.locator('.maplibregl-canvas').click({ position: point });
			const sheet = page.locator('[data-map-in-view-sheet]');
			await expect(sheet).toBeVisible();
			const handle = sheet.getByRole('slider');
			const body = sheet.locator('[data-slot="bottom-sheet-body"]');
			const close = sheet.getByRole('button', {
				name: locale === 'fr' ? 'Fermer' : 'Close',
				exact: true,
			});
			const selectionLink = body
				.locator('[data-selection-kind="vehicle"]')
				.getByRole('link')
				.last();
			// Let the open transition settle; a key pressed mid-transition can be dropped.
			await expect(sheet).toHaveAttribute('data-detent', 'half');
			await sheet.evaluate((el) =>
				Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished)),
			);
			for (const [key, detent] of [
				['ArrowUp', 'full'],
				['Home', 'peek'],
				['ArrowUp', 'half'],
			]) {
				if (detent === 'full') {
					// Repeating ArrowUp at the top detent is harmless, so retry the first step.
					await expect(async () => {
						await handle.press(key);
						await expect(sheet).toHaveAttribute('data-detent', detent, { timeout: 1000 });
					}).toPass();
				} else {
					await handle.press(key);
					await expect(sheet).toHaveAttribute('data-detent', detent);
				}
				const geometry = await sheet.evaluate((el) => {
					const box = el.getBoundingClientRect();
					const body = el.querySelector<HTMLElement>('[data-slot="bottom-sheet-body"]')!;
					const chrome = ['[data-testid="nav-pill"]', '[data-slot="app-frame-header"]'].map(
						(selector) => document.querySelector(selector)!.getBoundingClientRect().bottom,
					);
					return {
						top: box.top,
						height: box.height,
						body: body.clientHeight,
						scroll: body.scrollHeight,
						titleBottom: el.querySelector('[data-slot="sheet-title"]')!.getBoundingClientRect()
							.bottom,
						chromeBottom: Math.max(...chrome),
					};
				});
				expect(geometry.top, JSON.stringify(geometry)).toBeGreaterThanOrEqual(0);
				expect(geometry.height).toBeLessThanOrEqual(viewport.height);
				if (detent === 'full') {
					expect(geometry.top, JSON.stringify(geometry)).toBeCloseTo(viewport.height * 0.1, 0);
					expect(geometry.height).toBeCloseTo(viewport.height * 0.9, 0);
				} else
					expect(geometry.height).toBeCloseTo(detent === 'peek' ? 168 : viewport.height * 0.5, 0);
				if (detent !== 'full')
					expect(
						geometry.top - geometry.chromeBottom,
						JSON.stringify(geometry),
					).toBeGreaterThanOrEqual(0);
				expect(geometry.titleBottom).toBeLessThan(viewport.height);
				expect(geometry.body, JSON.stringify(geometry)).toBeGreaterThan(0);
				if (detent === 'peek') expect(geometry.scroll).toBeGreaterThan(geometry.body);
				await expect(async () => {
					const fit = await page.locator('.map-hero').evaluate((el) => {
						const canvas = el.querySelector('.maplibregl-canvas')!.getBoundingClientRect();
						return {
							padding: JSON.parse((el as HTMLElement).dataset.cameraPadding!) as {
								top: number;
								bottom: number;
							},
							height: canvas.height,
						};
					});
					expect(fit.padding.top).toBeGreaterThanOrEqual(16);
					expect(fit.padding.bottom).toBeGreaterThanOrEqual(16);
					expect(fit.padding.top + fit.padding.bottom).toBeLessThan(fit.height);
				}).toPass({ timeout: 5000 });
				await body.evaluate((el) => {
					el.scrollTop = el.scrollHeight;
				});
				await expect
					.poll(() => body.evaluate((el) => el.scrollTop + el.clientHeight - el.scrollHeight))
					.toBeGreaterThanOrEqual(-1);
				// The in-view list follows the selection, so scrolling to the body end
				// can leave the selected row's link above the scrollport.
				await selectionLink.scrollIntoViewIfNeeded();
				await expect(selectionLink).toBeInViewport({ ratio: 1 });
				await expect(close).toBeInViewport({ ratio: 1 });
			}
			// A fixed pixel peek must also fit when the viewport is shorter than that stop.
			await page.setViewportSize({ width: viewport.width, height: 150 });
			await handle.press('Home');
			await expect
				.poll(() => sheet.evaluate((el) => el.getBoundingClientRect().height))
				.toBeLessThanOrEqual(150);
		});
