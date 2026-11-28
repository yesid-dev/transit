import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { copy as mapCopy } from '../src/lib/features/map/map.copy';
import { DEFAULT_LOCALE, PUBLISHED_LOCALES } from '../src/lib/i18n/config';

for (const locale of PUBLISHED_LOCALES)
	test(`${locale}: map credits clear the visible controls and source footer`, async ({ page }) => {
		await page.goto((locale === DEFAULT_LOCALE ? '' : `/${locale}`) + '/map');
		const attribution = page.getByLabel(mapCopy[locale].attributionToggle, { exact: true });
		const footer = page.locator('[data-slot="map-source-footer"]');
		const camera = page.locator('.map-camera-actions');
		const compact = page.viewportSize()!.width < 1024;
		const lowerChrome = compact ? page.locator('[data-slot="map-mobile-peek"]') : footer;
		await expect(attribution).toBeVisible();
		await expect(lowerChrome).toBeVisible();
		if (compact) await expect(footer).toBeHidden();
		await expect(camera).toBeVisible();
		for (const expanded of [false, true]) {
			if (expanded) await attribution.click();
			const credit = (await attribution.locator('..').boundingBox())!;
			const navigation = (await camera.boundingBox())!;
			expect(credit.y + credit.height).toBeLessThanOrEqual((await lowerChrome.boundingBox())!.y);
			expect(
				credit.x >= navigation.x + navigation.width ||
					credit.x + credit.width <= navigation.x ||
					credit.y >= navigation.y + navigation.height ||
					credit.y + credit.height <= navigation.y,
			).toBe(true);
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
	await expect(main.locator('[data-slot="screen-title"] .stop-code')).toBeVisible();
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

test('Record listings keep the title, answer and results before the page edge', async ({
	page,
}) => {
	for (const [path, title] of [
		['/lines', 'Lines'],
		['/stops', 'Stops'],
		['/vehicles', 'Vehicles'],
	] as const) {
		await page.goto(`${path}?provider=stm`);
		const screen = page.getByRole('main').locator('[data-record-screen]');
		const firstGroup = screen.locator('[data-page-section-edges]').first();
		const heading = firstGroup.getByRole('heading', { level: 1, name: title, exact: true });
		await expect(heading).toBeVisible();
		const edge = screen.locator('[data-slot="page-section-boundary"]').first();
		await expect(edge).toHaveAttribute('data-variant', 'hand-drawn');
		await expect(edge).toHaveAttribute('data-stroke-segments', '1');
		await expect(edge.locator('svg')).toBeVisible();
		await expect(edge.locator('svg')).toHaveCSS('clip-path', 'none');
		const order = await screen.evaluate((element) => {
			const title = element.querySelector('h1')!;
			const boundary = element.querySelector('[data-slot="page-section-boundary"]')!;
			const answer = element.querySelector('[data-slot="screen-answer"]')!;
			const precedes = (first: Element, second: Element) =>
				Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
			const listing = element.querySelector('[data-slot="record-card"]')!;
			const section = title.closest('[data-page-section-edges]');
			return (
				!!section &&
				section.contains(answer) &&
				section.contains(listing) &&
				precedes(title, answer) &&
				precedes(answer, listing) &&
				precedes(listing, boundary)
			);
		});
		expect(order).toBe(true);
		await expect(screen.locator('[data-slot="blueprint-listing-art"]')).toHaveCount(0);
	}
});
