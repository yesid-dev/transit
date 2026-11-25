import { expect, test } from '@playwright/test';

test.use({ bypassCSP: true });

for (const [path, back] of [
	['/lines/24', 'All lines'],
	['/stop/S1', 'All stops'],
] as const)
	test(path + ': Back restores the Record view and its selected dates', async ({ page }) => {
		await page.goto(path + '?provider=stm&recordFrom=2026-11-08&recordTo=2026-11-14');
		const record = page.getByRole('main').getByRole('link', { name: back, exact: true });
		await expect(record).toBeVisible();
		const headline = page.locator('#punctuality [data-slot="answer-lead"]');
		await expect(headline).toBeVisible();
		const reading = await headline.textContent();
		await page.getByRole('button', { name: 'Open menu', exact: true }).click();
		await page
			.getByRole('navigation', { name: 'Navigation menu' })
			.getByRole('link', { name: 'Lines', exact: true })
			.click();
		await expect(page).toHaveURL((url) => url.pathname === '/lines');
		await page.goBack();
		await expect(page).toHaveURL(
			(url) =>
				url.pathname === path &&
				url.searchParams.get('recordFrom') === '2026-11-08' &&
				url.searchParams.get('recordTo') === '2026-11-14',
		);
		await expect(record).toBeVisible();
		await expect(headline).toHaveText(reading!);
	});
