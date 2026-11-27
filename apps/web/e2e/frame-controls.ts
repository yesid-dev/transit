import { expect, type Page } from '@playwright/test';

export async function waitForFrameRailLayout(page: Page) {
	await expect(page.locator('html[data-hydrated]')).toHaveCount(1);
	const frame = page.locator('[data-slot="app-frame"]');
	const expected = await frame.evaluate((element) => {
		const root = document.documentElement;
		const frameWidth = element.getBoundingClientRect().width;
		// AppFrame includes the viewport scrollbar when the frame spans the page.
		const width = Math.round(frameWidth) === root.clientWidth ? window.innerWidth : frameWidth;
		const rem = parseFloat(getComputedStyle(root).fontSize);
		return width >= 64 * rem ? 'paired' : 'compact';
	});
	await expect(frame).toHaveAttribute('data-rail-layout', expected);
	return expected;
}

export async function openFrameControls(
	page: Page,
	locale: 'en' | 'fr' = 'en',
	activation: 'pointer' | 'keyboard' = 'pointer',
) {
	const layout = await waitForFrameRailLayout(page);
	const rail = page.locator('.app-frame-controls-rail');
	if (layout === 'compact' && !(await rail.isVisible())) {
		const pill = page.getByRole('button', {
			name: locale === 'fr' ? /^Options.*Ouvrir les options/ : /^Controls.*Open controls/,
		});
		if (activation === 'keyboard') await pill.press('Enter');
		else await pill.click();
	}
	await expect(rail).toBeVisible();
	return rail;
}

export async function closeCompactFrameControls(page: Page, locale: 'en' | 'fr' = 'en') {
	const sheet = page.getByRole('dialog', {
		name: locale === 'fr' ? 'Options' : 'Controls',
		exact: true,
	});
	if (await sheet.isVisible()) await page.keyboard.press('Escape');
}
