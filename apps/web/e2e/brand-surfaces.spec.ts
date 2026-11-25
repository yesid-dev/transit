import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { SURFACE_NAV } from '../src/lib/content/nav';
import { copy as mapCopy } from '../src/lib/features/map/map.copy';
import { DEFAULT_LOCALE, PUBLISHED_LOCALES } from '../src/lib/i18n/config';

for (const locale of PUBLISHED_LOCALES)
	test(`${locale}: map credits stay immediately above the location control`, async ({ page }) => {
		await page.goto((locale === DEFAULT_LOCALE ? '' : `/${locale}`) + '/map');
		const attribution = page.getByLabel(mapCopy[locale].attributionToggle, { exact: true });
		const location = page.getByRole('button', { name: mapCopy[locale].nearMe, exact: true });
		await expect(attribution).toBeVisible();
		await expect(location).toBeVisible();
		for (const expanded of [false, true]) {
			if (expanded) await attribution.click();
			const credit = (await attribution.locator('..').boundingBox())!,
				fab = (await location.boundingBox())!;
			expect(credit.y + credit.height).toBeLessThanOrEqual(fab.y);
			expect(Math.abs(credit.x + credit.width - fab.x - fab.width)).toBeLessThanOrEqual(1);
			expect(credit.x).toBeGreaterThanOrEqual(0);
		}
		await attribution.focus();
		await attribution.press('Enter');
		await expect(attribution).toBeFocused();
	});

const departures = JSON.parse(readFileSync(new URL('./departures.json', import.meta.url), 'utf8'));
const stop = Object.keys(departures.stops)[0]!;

test.use({ bypassCSP: true });

test.beforeEach(async ({ page }) => {
	await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
});

test("a metric's defining SQL is a named, keyboard-reachable region", async ({ page }) => {
	await page.goto('/metrics/archive');
	const sqlCards = '[data-slot="typed-information-card"][data-kind="sql"]';
	const region = page.locator(sqlCards).first().getByRole('region');
	await expect(region).toBeVisible();
	await expect(region).toHaveAccessibleName(/\S/);
	await region.focus();
	await expect(region).toBeFocused();
	await expect(region).toContainText(/SELECT/i);
	const colors = await region.evaluate(
		(pre) =>
			new Set(Array.from(pre.querySelectorAll('span'), (span) => getComputedStyle(span).color))
				.size,
	);
	expect(colors, 'the SQL is syntax-colored').toBeGreaterThan(1);
});

test('the Stop Record header clears the frame and gives its back link a full target', async ({
	page,
}) => {
	await page.goto('/stop/' + stop);
	const main = page.getByRole('main');
	const link = main.getByRole('link', { name: 'All stops', exact: true });
	const title = main.getByRole('heading', { level: 1 });
	await expect(link).toBeVisible();
	await expect(title).toBeVisible();
	await expect(main.locator('[data-slot="article-header"] canvas')).toHaveCount(0);
	await page.evaluate(() => document.fonts.ready);
	const chrome = (await page.locator('[data-slot="app-frame-header"]').boundingBox())!;
	const back = (await link.boundingBox())!;
	const heading = (await title.boundingBox())!;
	expect(back.y).toBeGreaterThanOrEqual(chrome.y + chrome.height);
	expect(heading.y).toBeGreaterThanOrEqual(chrome.y + chrome.height);
	const overlaps =
		back.x < heading.x + heading.width &&
		heading.x < back.x + back.width &&
		back.y < heading.y + heading.height &&
		heading.y < back.y + back.height;
	expect(overlaps).toBe(false);
	expect(back.height).toBeGreaterThanOrEqual(44);
});

test('listing headers are reading frames: a visible title and no artwork', async ({ page }) => {
	// The Lines and Stops finders were the last expressive listings; both now lead with the title.
	let listings = 0;
	for (const { href } of SURFACE_NAV) {
		await page.goto(href);
		const header = page.locator('[data-slot="blueprint-listing-header"]');
		if (!(await header.count())) continue;
		listings += 1;
		const presentation = await page
			.locator('[data-slot="listing-frame"]')
			.first()
			.getAttribute('data-presentation');
		expect(presentation, href).toBe('reading');
		await expect(header.locator('h1')).toBeVisible();
		await expect(header.locator('[data-slot="blueprint-listing-art"]')).toHaveCount(0);
	}
	expect(listings).toBeGreaterThanOrEqual(1);

	await page.goto('/lines');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lines');
	await expect(page.locator('[data-slot="blueprint-listing-art"]')).toHaveCount(0);
});
