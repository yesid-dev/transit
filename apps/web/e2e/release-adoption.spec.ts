import { expect, test } from '@playwright/test';
import { NAV_GROUPS, SEARCH_LABEL } from '../src/lib/content/nav';
import { navPillCopy } from '../src/lib/i18n/messages';
import { DEFAULT_LOCALE } from '../src/lib/i18n/config';

/** The language link's spoken name: the control, then the current language by its own name. */
const languageName = (locale: 'en' | 'fr') =>
	`${navPillCopy[locale].language}: ${navPillCopy[locale].names[locale]} (EN FR)`;

for (const locale of ['en', 'fr'] as const) {
	test(`${locale}: the 390px pill holds both toggles before hydration`, async ({
		browser,
		baseURL,
	}) => {
		const context = await browser.newContext({
			javaScriptEnabled: false,
			viewport: { width: 390, height: 844 },
		});
		try {
			const page = await context.newPage();
			const path = locale === DEFAULT_LOCALE ? '/privacy' : `/${locale}/privacy`;
			await page.goto(new URL(path, baseURL).href);
			const copy = navPillCopy[locale];
			const pill = page.getByTestId('nav-pill');
			const theme = pill.getByRole('switch', { name: copy.theme, exact: true });
			const language = pill.getByRole('link', { name: languageName(locale), exact: true });
			await expect(theme).toBeVisible();
			await expect(theme).toBeEnabled();
			await expect(language).toBeVisible();
			await expect(page.getByRole('button', { name: copy.openMenu })).not.toHaveAttribute(
				'popovertarget',
			);
			const bounds = (await pill.boundingBox())!;
			expect(bounds.x).toBeGreaterThanOrEqual(0);
			expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
			for (const control of [theme, language]) {
				const box = (await control.boundingBox())!;
				expect(box.x).toBeGreaterThanOrEqual(bounds.x);
				expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
			}
			await expect(language).toHaveAttribute('data-sveltekit-reload', 'true');
			await language.click();
			const other = locale === 'en' ? 'fr' : 'en';
			await expect(page.locator('html')).toHaveAttribute('lang', other);
			await expect(page).toHaveURL(
				(url) => url.pathname === (other === DEFAULT_LOCALE ? '/privacy' : `/${other}/privacy`),
			);
		} finally {
			await context.close();
		}
	});

	test(`${locale} 320: the narrowest pill keeps the search word whole`, async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 700 });
		await page.goto(locale === DEFAULT_LOCALE ? '/privacy' : `/${locale}/privacy`, {
			waitUntil: 'networkidle',
		});
		await page.evaluate(() => document.fonts.ready);
		const copy = navPillCopy[locale];
		const pill = page.getByTestId('nav-pill');
		const search = pill.getByRole('link', { name: copy.searchAria.all });
		await expect(search).toHaveText(SEARCH_LABEL[locale]);
		const word = await search.evaluate((link) => {
			const range = document.createRange();
			range.selectNodeContents(link.querySelector('span')!);
			return { lines: range.getClientRects().length, spill: link.scrollHeight - link.clientHeight };
		});
		expect(word).toEqual({ lines: 1, spill: 0 });
		const bounds = (await pill.boundingBox())!;
		expect(bounds.x).toBeGreaterThan(0);
		expect(bounds.x + bounds.width).toBeLessThan(320);
		for (const control of [
			pill.getByRole('switch', { name: copy.theme, exact: true }),
			pill.getByRole('link', { name: languageName(locale), exact: true }),
		]) {
			await expect(control).toBeVisible();
		}
	});

	for (const width of [390, 1440]) {
		test(`${locale} ${width}: compact shell and grouped keyboard menu`, async ({ page }) => {
			await page.setViewportSize({ width, height: 900 });
			await page.goto(locale === DEFAULT_LOCALE ? '/metrics' : `/${locale}/metrics`, {
				waitUntil: 'networkidle',
			});
			await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
			const copy = navPillCopy[locale];
			const header = page.getByTestId('nav-pill');
			const theme = header.getByRole('switch', { name: copy.theme, exact: true });
			const language = header.getByRole('link', { name: languageName(locale), exact: true });
			await expect(theme).toBeVisible();
			await expect(language).toBeVisible();
			if (width === 390) {
				await expect(header.getByRole('link', { name: copy.searchAria.all })).toHaveText(
					SEARCH_LABEL[locale],
				);
				await expect(header.getByRole('button', { name: copy.refresh })).toBeHidden();
			} else {
				const refresh = header.getByRole('button', { name: copy.refresh });
				await refresh.focus();
				await expect(refresh).toBeFocused();
				await expect(refresh).toHaveCSS('outline-width', '2px');
				await expect(refresh).toHaveCSS('outline-style', 'solid');
				await expect(refresh).toHaveCSS('outline-offset', '2px');
			}
			const open = page.getByRole('button', { name: copy.openMenu });
			await open.focus();
			await page.keyboard.press('Enter');
			const dialog = page.getByRole('dialog');
			for (const group of NAV_GROUPS) {
				await expect(dialog.getByRole('heading', { name: group.label[locale] })).toBeVisible();
			}
			if (width === 390) {
				await expect(dialog.getByRole('button', { name: copy.refresh, exact: true })).toBeVisible();
			}
			// The open menu adds no second theme or language control; the pill keeps the only pair.
			await expect(theme).toBeVisible();
			await expect(language).toBeVisible();
			await expect(page.getByRole('switch', { name: copy.theme })).toHaveCount(1);
			await expect(page.getByTestId('language-toggle')).toHaveCount(1);
			await page.keyboard.press('Escape');
			await expect(dialog).toBeHidden();
			if (width === 390) {
				await expect(header.getByRole('button', { name: copy.refresh, exact: true })).toBeHidden();
			}
			await expect(page.getByRole('button', { name: copy.openMenu })).toBeFocused();
			const footer = page.getByRole('contentinfo');
			await expect(footer).not.toContainText(/SYSTEM|SYSTÈME|\d{4}\.\d{2}\.\d{2}/);
			await expect(footer.locator('[data-slot="status-dot"]')).toHaveCount(0);
		});
	}
}
