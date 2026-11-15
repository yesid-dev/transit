import { expect, type Locator, type Page } from '@playwright/test';
import { test } from './layout-test';
import { navPillCopy } from '../src/lib/i18n/messages';
import { headerSearchCopy } from '../src/lib/components/shell/headerSearch.copy';
import { localizeHref } from '../src/lib/i18n/routing';

async function targetFits(control: Locator, page: Page) {
	await expect(control).toBeVisible();
	const box = (await control.boundingBox())!;
	expect(box.width).toBeGreaterThanOrEqual(44);
	expect(box.height).toBeGreaterThanOrEqual(44);
	expect(box.x).toBeGreaterThanOrEqual(0);
	expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
}

async function pillFits(pill: Locator) {
	const box = (await pill.boundingBox())!;
	expect(box.x).toBeGreaterThanOrEqual(0);
	expect(box.x + box.width).toBeLessThanOrEqual(
		await pill.evaluate(() => document.documentElement.clientWidth),
	);
}

async function singleLine(label: Locator) {
	expect(
		await label.evaluate((element) => {
			const range = document.createRange();
			range.selectNodeContents(element);
			return range.getClientRects().length;
		}),
	).toBe(1);
}

for (const locale of ['en', 'fr'] as const)
	test(`${locale} shell keeps its labelled search and both toggles at every header width`, async ({
		page,
	}) => {
		await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
		const copy = navPillCopy[locale];
		for (const width of [320, 360, 390, 768, 1206, 1280]) {
			await page.setViewportSize({ width, height: 900 });
			await page.goto(localizeHref('/privacy?provider=stm', locale));
			await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
			const pill = page.getByTestId('nav-pill');
			await pillFits(pill);
			await singleLine(pill.locator('[data-slot="product-brand-name"]'));
			const theme = pill.getByRole('switch', { name: copy.theme });
			const language = pill.getByTestId('language-toggle');
			const menu = pill.getByRole('button', { name: copy.openMenu, exact: true });
			for (const control of [theme, language, menu]) await targetFits(control, page);
			await expect(language).toHaveAccessibleName(new RegExp(copy.names[locale]));
			const refresh = pill.getByRole('button', { name: copy.refresh, exact: true });
			if (width < 600) await expect(refresh).toBeHidden();
			else await targetFits(refresh, page);
			if (width < 1024) {
				const search = pill.getByRole('button', { name: copy.searchAria.all, exact: true });
				await targetFits(search, page);
				await expect(search).toHaveText(headerSearchCopy[locale].trigger);
				await singleLine(search.locator('span'));
			}
			await menu.focus();
			await page.keyboard.press('Enter');
			await expect(page.getByRole('dialog', { name: copy.menu })).toBeVisible();
			await pillFits(pill);
			await singleLine(pill.locator('[data-slot="product-brand-name"]'));
			await targetFits(refresh, page);
			await expect(
				pill.getByRole('button', { name: copy.searchAria.all, exact: true }),
			).toBeHidden();
			for (const control of [theme, language]) await targetFits(control, page);
			await expect(page.getByTestId('theme-toggle')).toHaveCount(1);
			await expect(page.getByTestId('language-toggle')).toHaveCount(1);
			await page.keyboard.press('Escape');
			await expect(menu).toBeFocused();
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
				width,
			);
			await expect(page.getByTestId('footer').getByText(/^(SYSTEM|SYSTÈME)/)).toHaveCount(0);
		}
	});
