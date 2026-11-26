import { expect, type Page } from '@playwright/test';
import { pendingLayoutAnimations } from './layout-animations';

/** Wait for fonts, finite animations and two unchanged readings of the header geometry. */
export async function waitForStableHeader(page: Page): Promise<void> {
	await page.evaluate(() => document.fonts.ready);
	await expect.poll(() => page.evaluate(pendingLayoutAnimations)).toBe(0);
	let previous = '';
	let unchanged = 0;
	await expect
		.poll(
			async () => {
				const current = await page.getByTestId('nav-pill').evaluate((nav) =>
					JSON.stringify(
						[...nav.querySelectorAll('a, input, [data-slot^="wordmark-"]')].map((el) => {
							const r = el.getBoundingClientRect();
							return [r.x, r.y, r.width, r.height];
						}),
					),
				);
				unchanged = current === previous ? unchanged + 1 : 0;
				previous = current;
				return unchanged;
			},
			{ intervals: [100] },
		)
		.toBeGreaterThanOrEqual(2);
}
