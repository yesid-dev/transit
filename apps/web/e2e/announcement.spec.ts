import { expect, test } from '@playwright/test';
import { announcement as config } from '../src/lib/site/announcement';

const banner = '[data-slot="announcement-banner"]';
const hydrated = 'html[data-hydrated]';

test.skip(!config.enabled, 'No announcement is active');

test.beforeEach(async ({ page }) => {
	await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
});

for (const [prefix, message, closeLabel] of [
	['', 'We got all the feedback and are working on it', 'Close this announcement'],
	['/fr', 'Nous avons reçu tous vos commentaires et nous y travaillons', 'Fermer cette annonce'],
] as const) {
	test(`${prefix || 'en'}: a first visit has a localized Roadmap announcement`, async ({
		page,
	}) => {
		await page.goto(`${prefix}/privacy`);
		const announcement = page.locator(banner);
		const link = announcement.getByRole('link', { name: message, exact: true });
		await expect(link).toHaveAttribute('href', `${prefix}/roadmap`);
		await expect(announcement.getByRole('button', { name: closeLabel })).toBeEnabled();
		await link.click();
		await expect(page).toHaveURL((url) => url.pathname === `${prefix}/roadmap`);
		await expect(announcement).toBeVisible();
	});
}

test('the same dismissal hides the banner before hydration, across routes and languages', async ({
	page,
}) => {
	await page.goto('/privacy');
	const announcement = page.locator(banner);
	const close = announcement.getByRole('button');
	await expect(close).toBeEnabled();
	await page.keyboard.press('Tab');
	await expect(announcement.getByRole('link')).toBeFocused();
	await expect(announcement.getByRole('link')).toHaveCSS('outline-style', 'solid');
	await expect(announcement.getByRole('link')).not.toHaveCSS('outline-width', '0px');
	await page.keyboard.press('Tab');
	await expect(close).toBeFocused();
	await expect(close).toHaveCSS('outline-style', 'solid');
	await expect(close).not.toHaveCSS('outline-width', '0px');
	await page.keyboard.press('Enter');
	await expect(announcement).toBeHidden();
	const heading = page.locator('main h1');
	const closedTop = (await heading.boundingBox())!.y;

	// Retain the CSP-protected boot script but withhold hydration to inspect the first layout.
	const script = (url: URL) => /\/_app\/immutable\/.*\.js$/.test(url.pathname);
	await page.route(script, (route) => route.abort());
	await page.reload();
	await expect(page.locator('html')).toHaveAttribute('data-announcement-dismissed', 'roadmap-1');
	await expect(page.locator(hydrated)).toHaveCount(0);
	await expect(announcement).not.toHaveAttribute('hidden');
	await expect(announcement).toBeHidden();
	await expect.poll(async () => (await heading.boundingBox())!.y).toBeCloseTo(closedTop, 0);
	await page.unroute(script);
	await page.goto('/fr/terms');
	await expect(page.locator(hydrated)).toHaveCount(1);
	await expect(page.locator('html')).toHaveAttribute('data-announcement-dismissed', 'roadmap-1');
	await expect(announcement).toBeHidden();
});

test('blocked storage leaves the banner visible and the page usable', async ({ page }) => {
	await page.addInitScript(() => {
		Object.defineProperty(window, 'localStorage', {
			get() {
				throw new DOMException('Storage blocked', 'SecurityError');
			},
		});
	});
	const errors: Error[] = [];
	page.on('pageerror', (error) => errors.push(error));
	await page.goto('/privacy');
	const announcement = page.locator(banner);
	await announcement.getByRole('button').click();
	await expect(announcement).toBeVisible();
	await announcement.getByRole('link').click();
	await expect(page).toHaveURL((url) => url.pathname === '/roadmap');
	await expect(announcement).toBeVisible();
	expect(errors).toEqual([]);
});

test('a wrapped phone banner leaves the map and its controls in the viewport', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/fr/map?provider=stm');
	await expect(page.locator(hydrated)).toHaveCount(1);
	await page.addStyleTag({ content: 'html { font-size: 200%; }' });
	await expect(page.locator('html')).toHaveCSS('font-size', '32px');
	const announcement = page.locator(banner);
	const close = announcement.getByRole('button');
	const map = page.getByTestId('map-progressive');
	await expect(close).toBeInViewport({ ratio: 1 });
	await expect(map).toBeInViewport({ ratio: 1 });
	const openBox = (await announcement.boundingBox())!;
	const mapBox = (await map.boundingBox())!;
	expect(openBox.height).toBeGreaterThan((await close.boundingBox())!.height);
	expect(mapBox.y).toBeCloseTo(openBox.y + openBox.height, 0);
	expect(mapBox.y + mapBox.height).toBeCloseTo(844, 0);
	expect(await page.evaluate(() => document.scrollingElement!.scrollHeight)).toBe(844);

	const filters = page.getByTestId('map-filter-pill');
	await filters.click();
	const drawer = page.locator('[data-m6b-controls-drawer]');
	await expect(drawer).toBeInViewport({ ratio: 1 });
	const pill = (await page.getByTestId('nav-pill').boundingBox())!;
	expect((await drawer.boundingBox())!.y).toBeGreaterThanOrEqual(pill.y + pill.height);
	await page.getByTestId('map-filter-done').click();
	await close.click();
	await expect(announcement).toBeHidden();
	await expect.poll(async () => (await map.boundingBox())!.height).toBeCloseTo(844, 0);
	await filters.click();
	await expect(drawer).toBeInViewport({ ratio: 1 });
});
