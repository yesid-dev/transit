import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { test } from './layout-input-test';
import { captureUrl, layoutCapture } from './capture-fixture';
import { openMapInView } from './map-frame-controls';

const epoch = Date.parse(
	JSON.parse(readFileSync(new URL('./departures.json', import.meta.url), 'utf8')).generated_utc,
);

test.describe.configure({ mode: 'parallel' });

for (const provider of ['stm', 'octranspo'])
	for (const locale of ['en', 'fr'] as const)
		for (const { width, height } of [
			{ width: 390, height: 844 },
			{ width: 844, height: 390 },
			{ width: 1280, height: 900 },
		]) {
			test(`${provider} ${locale} ${width} detail navigation @layout`, async ({ page }) => {
				await page.setViewportSize({ width, height });
				await page.clock.setFixedTime(epoch + 30_000);
				await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
				await page.route(captureUrl, (route) => route.fulfill({ json: layoutCapture(provider) }));
				const mapPath = `${locale === 'fr' ? '/fr' : ''}/map`;
				const mapURL = `${mapPath}?provider=${provider}`;
				await page.goto(mapURL);

				const vehicle = page.getByRole('link', { name: 'layout-bus', exact: true });
				const panel = page.locator('[data-slot="map-detail-overlay"]');
				const link = panel.getByRole('link', {
					name: locale === 'fr' ? 'Véhicule layout-bus' : 'Vehicle layout-bus',
					exact: true,
				});
				const openSelection = async () => {
					await openMapInView(page);
					await expect(vehicle).toBeVisible();
					await vehicle.click();
					await expect(panel).toHaveAttribute('data-selection-kind', 'vehicle');
					await expect(panel.locator('[data-slot="detail-identity"]')).toContainText('layout-bus');
					// The sheet moves focus onto the selection as it mounts.
					await expect(async () => {
						await link.scrollIntoViewIfNeeded();
						await expect(link).toBeInViewport({ ratio: 1, timeout: 1000 });
					}).toPass({ timeout: 5000 });
				};
				await openSelection();
				await expect(link).toHaveAttribute('href', /\/vehicle\/layout-bus/);
				const overflow = await panel.evaluate((el) => el.scrollWidth - el.clientWidth);
				expect(overflow).toBeLessThanOrEqual(1);
				expect(
					(await new AxeBuilder({ page }).include('[data-slot="map-detail-overlay"]').analyze())
						.violations,
				).toEqual([]);

				const destination = new URL((await link.getAttribute('href'))!, page.url());
				await link.click();
				await expect(page).toHaveURL((url) => url.pathname === destination.pathname);
				await expect(page.locator('h1')).toContainText('layout-bus');
				await page.goBack();
				await expect(page).toHaveURL(
					(url) => url.pathname === mapPath && url.searchParams.get('provider') === provider,
				);
				await openSelection();
			});
		}
