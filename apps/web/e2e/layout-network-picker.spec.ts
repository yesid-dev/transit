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

	// Scrolling past the network row vacates its band: clicks pass through to page content
	// and AppFrame's backdrop stops right at the pill's bottom edge.
	await scrollTo(300);
	await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThanOrEqual(240);
	await expect.poll(async () => (await network.boundingBox())!.y).toBeLessThan(0);
	const scrolledState = await page.evaluate(() => {
		const navPill = document.querySelector('[data-testid="nav-pill"]')!;
		const chrome = document.querySelector('[data-slot="app-frame-chrome"]')!;
		const header = document.querySelector('[data-slot="app-frame-header"]')!;
		const siteHeader = document.querySelector('[data-slot="site-header"]')!;
		const pillBox = navPill.getBoundingClientRect();
		const hit = document.elementFromPoint(window.innerWidth / 2, pillBox.bottom + 24);
		return {
			pillTop: pillBox.top,
			pillBottom: Math.round(pillBox.bottom),
			headerHeight: Math.round(header.getBoundingClientRect().height),
			siteHeaderHeight: Math.round(siteHeader.getBoundingClientRect().height),
			chromeBackground: getComputedStyle(chrome).backgroundImage,
			hitInMain: Boolean(hit?.closest('main')),
			hitTag: hit ? `${hit.tagName}.${hit.className}` : null,
		};
	});
	expect(scrolledState.pillTop).toBeCloseTo(pillTop, 0);
	expect(scrolledState.headerHeight).toBe(scrolledState.siteHeaderHeight);
	expect(scrolledState.chromeBackground).toContain(`${scrolledState.pillBottom}px`);
	expect(scrolledState.hitInMain, `hit target in vacated band: ${scrolledState.hitTag}`).toBe(true);

	await scrollTo(0);
	await expect.poll(async () => (await network.boundingBox())!.y).toBeCloseTo(initial.y, 0);
});
