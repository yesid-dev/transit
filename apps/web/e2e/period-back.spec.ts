import { expect, test } from '@playwright/test';

test.use({ bypassCSP: true });

for (const [path, region] of [
	['/lines/24', 'Line views'],
	['/stop/S1', null],
] as const)
	test(path + ': Back restores the Record view and its selected dates', async ({ page }) => {
		await page.goto(path + '?provider=stm&recordFrom=2026-11-08&recordTo=2026-11-14');
		const record = region
			? page
					.getByRole('navigation', { name: region })
					.getByRole('link', { name: 'Record', exact: true })
			: page.getByRole('main').getByRole('link', { name: 'All stops', exact: true });
		if (region) await expect(record).toHaveAttribute('aria-current', 'page');
		else await expect(record).toBeVisible();
		const headline = page.locator(
			region ? '#punctuality dl' : '#punctuality [data-slot="answer-lead"]',
		);
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
		if (region) await expect(record).toHaveAttribute('aria-current', 'page');
		else await expect(record).toBeVisible();
		await expect(headline).toHaveText(reading!);
	});
