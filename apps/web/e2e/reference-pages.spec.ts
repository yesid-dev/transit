import { expect, test } from '@playwright/test';

const dates = 'frameMode=record&recordFrom=2026-11-14&recordTo=2026-11-20';

for (const [locale, prefix, provider] of [
	['en', '', 'stm'],
	['fr', '/fr', 'octranspo'],
] as const) {
	test(`Search has one field and a working example in ${locale}`, async ({ page }) => {
		await page.goto(`${prefix}/search?provider=${provider}`);
		const main = page.getByRole('main');
		const field = main.getByRole('textbox');
		await expect(field).toBeVisible();
		if (await page.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches)) {
			await expect(field).toBeFocused();
		}
		await expect(page.locator('[data-slot="app-frame-chrome"] input[type="search"]')).toHaveCount(
			0,
		);
		const examples = main.getByRole('link').filter({ hasText: /^\d+$/ });
		await expect(examples.first()).toBeVisible();
		const example = (await examples.first().textContent())!.trim();
		await examples.first().click();
		await expect(field).toHaveValue(example);
		await expect(
			main.getByRole('link', {
				name: new RegExp(`^${locale === 'fr' ? 'Ligne' : 'Line'} ${example}\\b`),
			}),
		).toHaveAttribute('href', new RegExp(`^${prefix}/lines/`));
		await expect(
			page.getByTestId('footer').getByRole('link', {
				name: locale === 'fr' ? 'Recherche' : 'Search',
				exact: true,
			}),
		).toHaveAttribute('href', new RegExp(`^${prefix}/search`));
	});
}

test('dark Daily report and How we measure print with readable ink and no site controls', async ({
	page,
}) => {
	await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
	for (const path of ['/receipt', '/metrics']) {
		await page.goto(`${path}?provider=stm&${dates}`);
		const main = page.getByRole('main');
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
		await expect(main.locator('[data-slot="record-card"]').first()).toBeVisible();
		await page.emulateMedia({ media: 'print' });
		await expect(page.locator('[data-slot="app-frame-chrome"]')).toBeHidden();
		await expect(page.getByTestId('footer')).toBeHidden();
		await expect(main.getByRole('button', { name: 'Cite', exact: true })).toBeHidden();
		await expect(main.getByRole('heading', { level: 1 })).toBeVisible();
		const ink = await main.evaluate((node) => getComputedStyle(node).color);
		expect(ink).toBe('rgb(19, 25, 35)');
		await page.emulateMedia({ media: 'screen' });
	}
});
