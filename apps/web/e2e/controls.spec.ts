import { expect, test } from '@playwright/test';
import { copy as searchCopy } from '../src/lib/features/search/search.copy';
import { PUBLISHED_LOCALES } from '../src/lib/i18n/config';
import { localizeHref } from '../src/lib/i18n/routing';

test.use({ bypassCSP: true });
test.beforeEach(async ({ page }) => {
	await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
});

for (const locale of PUBLISHED_LOCALES) {
	test(`${locale}: shared search keeps its name, typing and 44px target`, async ({ page }) => {
		await page.goto(localizeHref('/search', locale));
		const box = page.getByRole('textbox', { name: searchCopy[locale].inputLabel });
		await expect(box).toBeVisible();
		await expect(page.locator('[data-slot="listing-search-field"] svg')).toBeVisible();
		expect((await box.boundingBox())!.height).toBeGreaterThanOrEqual(44);
		await expect(async () => {
			await box.fill('Sherbrooke');
			await expect(
				page
					.getByRole('main')
					.getByRole('link', { name: /Sherbrooke/ })
					.first(),
			).toBeVisible({ timeout: 1_000 });
		}).toPass();
	});
}

test('load-more keeps a visible keyboard ring and loads the next batch', async ({ page }) => {
	await page.setExtraHTTPHeaders({ 'x-transit-fixture-scope': 'stops-pagination' });
	await page.goto('/stops?provider=stm&q=Pagination%20sample');
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
	const results = page.locator('#stop-results');
	const rows = results.locator('tbody tr');
	await expect(rows).toHaveCount(20);
	const pager = results.locator('[data-slot="show-more"]');
	const more = pager.getByRole('button', { name: 'Show 20 more', exact: true });
	await expect(more).toBeVisible();
	await more.focus();
	await page.keyboard.press('Shift+Tab');
	await page.keyboard.press('Tab');
	await expect(more).toBeFocused();
	const ring = await more.evaluate((element) => {
		const style = getComputedStyle(element);
		return {
			visible: element.matches(':focus-visible'),
			style: style.outlineStyle,
			width: parseFloat(style.outlineWidth),
		};
	});
	expect(ring.visible).toBe(true);
	expect(ring.style).toBe('solid');
	expect(ring.width).toBeGreaterThanOrEqual(2);
	expect((await more.boundingBox())!.height).toBeGreaterThanOrEqual(44);
	await page.keyboard.press('Enter');
	await expect(rows).toHaveCount(40);
	await expect(pager.getByRole('status')).toHaveText('Showing 40 of 45');
	await expect(
		rows.nth(20).getByRole('link', { name: 'Pagination sample 21', exact: true }),
	).toBeFocused();
	await expect(
		rows.last().getByRole('link', { name: 'Pagination sample 40', exact: true }),
	).toBeVisible();
});
