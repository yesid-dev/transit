import { expect, type Page } from '@playwright/test';

export async function openFrameControls(page: Page, locale: 'en' | 'fr' = 'en') {
	await expect(page.locator('html[data-hydrated]')).toHaveCount(1);
	const rail = page.locator('.app-frame-controls-rail');
	if (!(await rail.isVisible())) {
		await page
			.getByRole('button', {
				name: locale === 'fr' ? /^Commandes.*Ouvrir les commandes/ : /^Controls.*Open controls/,
			})
			.click();
	}
	await expect(rail).toBeVisible();
	return rail;
}

export async function closeCompactFrameControls(page: Page, locale: 'en' | 'fr' = 'en') {
	const sheet = page.getByRole('dialog', {
		name: locale === 'fr' ? 'Commandes' : 'Controls',
		exact: true,
	});
	if (await sheet.isVisible()) await page.keyboard.press('Escape');
}
