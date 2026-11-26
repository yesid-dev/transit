import { test } from './layout-test';
import { expect } from '@playwright/test';
import { expectLayout } from './layout-debt';
import { localizeHref } from '../src/lib/i18n/routing';

for (const locale of ['en', 'fr'] as const)
	test(
		locale + ' Line finder shows coverage and keeps its line identity readable @layout',
		async ({ page }, info) => {
			const query = '&recordFrom=2026-11-08&recordTo=2026-11-14';
			await page.goto(localizeHref('/lines', locale, 'stm') + query);
			const row = page
				.getByRole('row')
				.filter({ has: page.getByRole('link', { name: /^24 Sherbrooke/ }) });
			await expect(row).toBeVisible();
			await expect(row).toContainText(/80[.,]0\s?%/u);
			// On a phone, low coverage joins the row's sentence in lower case.
			await expect(row).toContainText(locale === 'fr' ? /faible couverture/iu : /low coverage/iu);
			await expect(
				page.getByRole('row').filter({ has: page.getByRole('link', { name: /99/ }) }),
			).toContainText(locale === 'fr' ? 'Trop peu de données pour conclure' : 'Too few to judge');
			await page.evaluate(() => document.fonts.ready);
			await expectLayout(page, info, []);
		},
	);
