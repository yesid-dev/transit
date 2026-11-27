import { expect } from '@playwright/test';
import { test } from './stop-search-fixture';

for (const locale of ['en', 'fr'] as const) {
	test(`${locale}: a slow unknown stop streams into the missing-stop view`, async ({
		page,
		stopSearch,
	}) => {
		const en = locale === 'en';
		await stopSearch.hold();
		try {
			const response = await page.goto(
				`${en ? '' : '/fr'}/stop/57135?provider=stm&frameMode=record`,
				{ waitUntil: 'commit' },
			);
			expect(response?.status()).toBe(200);
			await expect(
				page.getByRole('heading', { name: en ? 'Stop 57135' : 'Arrêt 57135' }),
			).toBeVisible();
			await stopSearch.release();
			await expect(
				page.getByRole('heading', {
					name: en ? 'This stop could not be found' : 'Cet arrêt est introuvable',
				}),
			).toBeVisible();
			await expect(page.locator('meta[name="robots"][content="noindex"]')).toHaveCount(1);
		} finally {
			await stopSearch.release();
		}
	});
}
