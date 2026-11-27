import { expect, test } from '@playwright/test';
import { openFrameControls } from './frame-controls';

test.use({ reducedMotion: 'reduce', bypassCSP: true });

for (const locale of ['en', 'fr'] as const) {
	const fr = locale === 'fr';
	test(`${locale} record actions open and return keyboard focus at the current viewport`, async ({
		page,
	}) => {
		const { width, height } = page.viewportSize()!;
		const centered = width >= 768;
		const close = fr ? 'Fermer' : 'Close';
		const record = '/lines/24?provider=stm&recordFrom=2026-11-08&recordTo=2026-11-14';
		await page.goto(fr ? '/fr' + record : record);
		await expect(page.locator('html[data-hydrated]')).toHaveCount(1);
		const actions = page.getByRole('main');

		for (const action of [
			{
				trigger: fr ? 'Télécharger' : 'Download',
				title: fr ? 'Télécharger les fichiers CSV' : 'Download the CSV files',
				width: 640,
			},
			{
				trigger: fr ? 'Citer' : 'Cite',
				title: centered ? (fr ? 'Citer ce bilan' : 'Cite this record') : fr ? 'Citer' : 'Cite',
				width: 768,
			},
			{
				trigger: fr ? 'Choisir d’autres dates' : 'Choose other dates',
				title: centered ? (fr ? 'Choisir des dates' : 'Choose dates') : fr ? 'Période' : 'Period',
				width: 640,
				dates: true,
			},
		]) {
			await test.step(action.trigger, async () => {
				const scope = action.dates ? await openFrameControls(page, locale, 'keyboard') : actions;
				const opener = scope.getByRole('button', { name: action.trigger, exact: true });
				const dialog = page.getByRole('dialog', { name: action.title, exact: true });
				await opener.press('Enter');
				await expect(dialog).toBeVisible();
				const box = (await dialog.boundingBox())!;
				if (centered) {
					await expect(dialog.getByRole('heading', { name: action.title })).toBeFocused();
					expect(box.width).toBeCloseTo(Math.min(action.width, width - 32), 0);
					expect(box.x * 2 + box.width).toBeCloseTo(width, 0);
					expect(box.y * 2 + box.height).toBeCloseTo(height, 0);
					expect(box.height).toBeLessThanOrEqual(Math.min(0.8 * height, 704) + 1);
					const closeButtons = dialog.getByRole('button', { name: close, exact: true });
					const footerClose = dialog
						.locator('[data-slot="sheet-footer"]')
						.getByRole('button', { name: close, exact: true });
					await expect(closeButtons).toHaveCount(2);
					await expect(footerClose).toBeInViewport({ ratio: 1 });
					await page.keyboard.press('Tab');
					await expect(dialog.locator(':focus')).toHaveCount(1);
					await page.keyboard.press('Shift+Tab');
					await expect(dialog.locator(':focus')).toHaveCount(1);
					await expect(dialog).toHaveCSS('animation-name', 'none');
					await page.keyboard.press('Escape');
					await expect(dialog).toBeHidden();
					await expect(opener).toBeFocused();

					await opener.press('Enter');
					await expect(dialog).toBeVisible();
					await page.mouse.click(4, 4);
					await expect(dialog).toBeHidden();
					await expect(opener).toBeFocused();

					await opener.press('Enter');
					await footerClose.click();
				} else {
					expect(box.x).toBeCloseTo(0, 0);
					expect(box.width).toBeCloseTo(width, 0);
					expect(box.y + box.height).toBeCloseTo(height, 0);
					await page.keyboard.press('Escape');
				}
				await expect(dialog).toBeHidden();
				await expect(opener).toBeFocused();
			});
		}
	});
}
