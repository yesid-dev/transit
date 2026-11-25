import { expect } from '@playwright/test';
import { test } from './layout-test';
import { captureFixture, captureUrl, captureVehicle } from './capture-fixture';
import { designPassCases } from './design-pass-cases';
import { recordMapFixture } from './map-record-fixture';
import { measureDesignPass, setWidth } from './design-pass-measure';
import { expectDesignPass } from './design-pass-debt';

const time = Date.parse('2026-11-23T16:00:00Z');

for (const { screen, provider, locale, key, href } of designPassCases) {
	test(`${screen} ${provider} ${locale} @layout`, async ({ page }, info) => {
		await setWidth(page, 1440);
		await page.clock.setFixedTime(time);
		await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
		await page.route(captureUrl, (route) => {
			const city = new URL(route.request().url()).searchParams.get('city')!;
			return route.fulfill({
				json: captureFixture(time, { city, vehicle_positions: [captureVehicle(time)] }),
			});
		});
		if (screen.startsWith('map-record')) await recordMapFixture(page);
		const response = await page.goto(href);
		expect(response?.status(), href).toBe(screen === 'error' ? 404 : 200);
		await expect(page.locator('html')).toHaveAttribute('lang', locale);
		await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
		await expect(page.getByRole('main')).toBeVisible();
		if (screen === 'overview') {
			await expect(page.locator('[data-slot="record-ranking"] li')).toHaveCount(6);
			await expect(page.locator('[data-slot="day-strip"]')).toBeVisible();
		}
		if (screen.startsWith('map-')) {
			// The app exposes the live map and makes the poster inert at this handoff.
			// Later source updates can make MapLibre's loaded() false again.
			await expect(page.locator('[data-map-progressive-state]')).toHaveAttribute(
				'data-map-progressive-state',
				'ready',
			);
			if (screen.startsWith('map-record')) {
				await expect(
					page.getByRole('main').getByRole('searchbox', {
						name: /^(Find a (stop|segment)|Trouver un (arrêt|segment))$/,
					}),
				).toBeVisible();
			}
		}
		const start = performance.now();
		// Adopted Overview checks the actual indicator. Existing debt fingerprints count outlines.
		const { report, focusSequences } = await measureDesignPass(page, {
			countShadowRings: screen === 'overview',
		});
		await info.attach('design-pass-measurements', {
			body: JSON.stringify({
				key,
				ms: Math.round(performance.now() - start),
				report,
				focusSequences,
			}),
			contentType: 'application/json',
		});
		await expect(page.getByRole('main')).not.toContainText(
			/\b(?:\d+ s (?:late|early)|seconds|secondes|\d+\s+(?:second|seconde))\b|\b\d{2}:\d{2}:\d{2} ·|\bDirection [01]\b/i,
		);
		expectDesignPass(screen, key, report);
	});
}
