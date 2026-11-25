import { expect } from '@playwright/test';
import { test } from './layout-test';

for (const provider of ['stm', 'octranspo'])
	for (const locale of ['en', 'fr'] as const)
		test(`${provider} ${locale} data health live answer fits and refreshes`, async ({ page }) => {
			await page.setViewportSize({ width: 390, height: 844 });
			const oldRequests: string[] = [];
			page.on('request', (request) => {
				if (/\/(?:data\/)?v1\//.test(new URL(request.url()).pathname))
					oldRequests.push(request.url());
			});
			await page.goto(`${locale === 'fr' ? '/fr' : ''}/status?provider=${provider}&frameMode=live`);
			const main = page.getByRole('main');
			await expect(main.getByRole('heading', { level: 1 })).toHaveText(
				locale === 'fr' ? 'Santé des données' : 'Data health',
			);
			const answer = main.locator('[data-slot="screen-answer"]');
			await expect(answer).toContainText(locale === 'fr' ? 'flux sont à jour' : 'feeds are fresh');
			await page.addStyleTag({ content: 'html { font-size: 200%; }' });
			await expect
				.poll(() => page.evaluate(() => document.documentElement.scrollWidth))
				.toBeLessThanOrEqual(390);
			await page.reload();
			await expect(answer).toContainText(locale === 'fr' ? 'flux sont à jour' : 'feeds are fresh');
			expect(oldRequests).toEqual([]);
		});
