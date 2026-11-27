import { expect, test } from '@playwright/test';

// Record cards are drawn on the server, so Download can be pressed before the page hydrates.
// Without JavaScript, the press must still lead to the same dates' files.
for (const locale of ['en', 'fr'] as const)
	test(`${locale} Download without JavaScript opens the same dates on the Download page`, async ({
		browser,
		baseURL,
	}) => {
		const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
		try {
			const page = await context.newPage();
			const prefix = locale === 'fr' ? '/fr' : '';
			await page.goto(`${prefix}/lines/24?provider=stm&recordFrom=2026-11-08&recordTo=2026-11-14`);
			await page
				.locator('#punctuality')
				.getByRole('button', { name: locale === 'fr' ? 'Télécharger' : 'Download', exact: true })
				.click();
			await expect(page).toHaveURL(
				(url) =>
					url.pathname === `${prefix}/download` &&
					url.hash === '#daily-files' &&
					url.searchParams.get('provider') === 'stm' &&
					url.searchParams.get('recordFrom') === '2026-11-08' &&
					url.searchParams.get('recordTo') === '2026-11-14',
			);
			await expect(page.locator('#daily-files')).toBeVisible();
		} finally {
			await context.close();
		}
	});
