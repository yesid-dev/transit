import { expect } from '@playwright/test';
import { waitForStableHeader } from './layout-header-settle';
import { test } from './layout-test';

// Only the phone header shows the compact network picker; the config runs this file at 390 px.
test('the compact network picker follows page scroll while the pill stays fixed @layout', async ({
	page,
}) => {
	await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
	await page.goto('/privacy?provider=stm');
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
	await page.evaluate(() => document.fonts.ready);
	const pill = page.getByTestId('nav-pill');
	const network = pill.locator('[data-slot="site-header-network"]');
	await expect(network).toBeVisible();
	await waitForStableHeader(page);
	const initial = (await network.boundingBox())!;
	const pillTop = (await pill.boundingBox())!.y;
	const scrollTo = (top: number) =>
		page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), top);

	await scrollTo(24);
	await expect.poll(() => page.evaluate(() => scrollY)).toBe(24);
	await expect.poll(async () => (await network.boundingBox())!.y).toBeCloseTo(initial.y - 24, 0);
	expect((await pill.boundingBox())!.y).toBeCloseTo(pillTop, 0);

	await scrollTo(0);
	await expect.poll(async () => (await network.boundingBox())!.y).toBeCloseTo(initial.y, 0);
});
