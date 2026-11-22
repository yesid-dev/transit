import { expect, type Page } from '@playwright/test';
import { test } from './layout-test';
import { localizeHref } from '../src/lib/i18n/routing';

// The header pill holds still while the app hydrates: the brand, both toggles and the bar links
// the server shows are the ones the app keeps. Transit's brand, search, refresh and network
// controls make its pill wider than SiteHeader's default link tiers assume, so the bar links wait
// for a 1280px header (linkTiers) before and after hydration alike (R1063-1: at 1206px the
// hydrated header dropped them and both toggles moved 169px).
const parts = {
	pill: '[data-testid="nav-pill"]',
	brand: '[data-slot="product-brand"]',
	theme: '[data-testid="theme-toggle"]',
	language: '[data-testid="language-toggle"]',
};

function header(page: Page) {
	return page.evaluate((parts) => {
		const box = (selector: string) => {
			const r = document.querySelector(selector)!.getBoundingClientRect();
			return [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 10) / 10);
		};
		return {
			...Object.fromEntries(Object.entries(parts).map(([name, selector]) => [name, box(selector)])),
			links: [...document.querySelectorAll('.nav-links [data-priority]')]
				.filter((link) => link.checkVisibility())
				.map((link) => link.textContent!.trim()),
		};
	}, parts);
}

// Measured once the header's own styles and every requested font face have settled.
async function settled(page: Page) {
	await expect(page.locator('[data-slot="app-frame-controls"]').getByRole('combobox')).toHaveCSS(
		'opacity',
		'0',
	);
	await expect
		.poll(() => page.evaluate(() => [...document.fonts].some((face) => face.status === 'loading')))
		.toBe(false);
	let last = await header(page);
	for (;;) {
		await page.evaluate(
			() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
		);
		const now = await header(page);
		if (JSON.stringify(now) === JSON.stringify(last)) return now;
		last = now;
	}
}

// Every measurement gets its own page and context: a reused document can keep hydration state
// from an earlier navigation (CI saw the fourth viewport find nav-hydrated already present on
// WebKit). One promise holds the app's scripts for that page; resolving it again is a no-op, so
// the cleanup below cannot strand a held request.
function heldScripts() {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	return { gate, release: () => release() };
}

for (const locale of ['en', 'fr'] as const)
	for (const width of [320, 360, 390, 768, 1206, 1280] as const)
		test(`${locale} ${width}px header holds still through hydration`, async ({ page }) => {
			await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
			await page.route('**/v1/**', async (route) => {
				const url = new URL(route.request().url());
				url.pathname = '/__layout/fresh' + url.pathname;
				await route.fulfill({ response: await route.fetch({ url: url.href }) });
			});
			// Only the app's scripts wait (CSS shares their folder): the server markup is measured
			// with its styles and fonts.
			const scripts = heldScripts();
			await page.route('**/_app/immutable/**/*.js', async (route) => {
				await scripts.gate;
				await route.fallback();
			});
			await page.setViewportSize({ width, height: 900 });
			try {
				await page.goto(localizeHref('/privacy?provider=stm', locale), {
					waitUntil: 'domcontentloaded',
				});
				await expect(page.locator(`${parts.pill}.nav-hydrated`)).toHaveCount(0);
				const before = await settled(page);
				expect(before.links, `${width}px bar links`).toHaveLength(width < 1280 ? 0 : 4);

				scripts.release();
				await expect(page.locator(`${parts.pill}.nav-hydrated`)).toBeVisible();
				expect(await settled(page), `${locale} ${width}px`).toEqual(before);
			} finally {
				scripts.release();
			}
		});
