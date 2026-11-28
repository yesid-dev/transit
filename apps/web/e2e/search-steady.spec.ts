import { expect, test } from '@playwright/test';

// /search draws before the search index arrives. When it lands, the tab counts fill reserved
// slots and the rows appear under the tabs: nothing already on screen moves (closing audit
// G3-M6, CLS 0.055 at 390 px before the fix).
const searchIndex = {
	schedule: {
		date: '2026-11-21',
		routes: [
			{ id: '1', short: '1', long: 'Verte', type: 1 },
			{ id: '51', short: '51', long: 'Édouard-Montpetit', type: 3 },
			{ id: '510', short: '510', long: 'Express Saint-Laurent', type: 3 },
		],
		stops: Array.from({ length: 1160 }, (_, i) => ({
			id: `s${i}`,
			code: String(51000 + i),
			lat: 45.5,
			lon: -73.6,
			name: `Saint-Michel / Rue ${i}`,
			routes: ['51'],
		})),
	},
	vehicles: [{ id: '51001' }, { id: '40051' }],
	vehicle_state: 'ready',
};

test.describe('search before its index arrives', () => {
	test.beforeEach(({ browserName }, info) => {
		// Layout Instability is a Chromium API; one project draws every width itself.
		test.skip(browserName !== 'chromium' || info.project.name !== 'desktop');
	});

	for (const [width, height] of [
		[390, 844],
		[320, 640],
		[1440, 900],
	] as const) {
		test(`keeps its tabs and rows still at ${width}px`, async ({ page }) => {
			await page.setViewportSize({ width, height });
			await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
			let release = () => {};
			const held = new Promise<void>((done) => (release = done));
			await page.route('**/api/search-index**', async (route) => {
				await held;
				await route.fulfill({ json: searchIndex });
			});
			await page.addInitScript(() => {
				const shifts: number[] = [];
				(window as unknown as { searchShifts: number[] }).searchShifts = shifts;
				new PerformanceObserver((list) => {
					for (const entry of list.getEntries() as unknown as {
						value: number;
						hadRecentInput: boolean;
					}[])
						if (!entry.hadRecentInput) shifts.push(entry.value);
				}).observe({ type: 'layout-shift', buffered: true });
			});
			await page.goto('/search?provider=stm&q=51');
			await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
			await page.evaluate(() => document.fonts.ready);
			await expect(page.getByRole('tab').first()).toBeVisible();
			release();
			await expect(page.getByRole('tab', { name: /^Stops\s*[\d,]+$/ })).toBeVisible();
			await expect(page.getByRole('tabpanel').getByRole('link').first()).toBeVisible();
			await page.evaluate(
				() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
			);
			const shifts = await page.evaluate(
				() => (window as unknown as { searchShifts: number[] }).searchShifts,
			);
			expect(shifts.reduce((sum, value) => sum + value, 0)).toBeLessThan(0.01);
		});
	}
});
