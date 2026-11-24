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
		if (screen.startsWith('map-')) {
			// The initial attribution links are replaced when the interactive map
			// loads. Measure the controls and Tab order only after that handoff.
			await expect
				.poll(() =>
					page.evaluate(() => {
						const map = Reflect.get(window, '__transitMap') as
							| { loaded: boolean; moving: boolean }
							| undefined;
						return Boolean(map?.loaded && !map.moving);
					}),
				)
				.toBe(true);
		}
		const start = performance.now();
		const report = await measureDesignPass(page);
		await info.attach('design-pass-measurements', {
			body: JSON.stringify({ key, ms: Math.round(performance.now() - start), report }),
			contentType: 'application/json',
		});
		expectDesignPass(screen, key, report);
	});
}
