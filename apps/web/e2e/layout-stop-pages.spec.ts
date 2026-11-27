import { expect } from '@playwright/test';
import { test } from './layout-test';
import { localizeHref } from '../src/lib/i18n/routing';

for (const locale of ['en', 'fr'] as const)
	test(
		locale + ' Stop hourly readings and finder rows fit the narrow viewport',
		async ({ page }) => {
			const period = '&recordFrom=2026-11-08&recordTo=2026-11-14';
			for (const width of [320, 390, 768, 1280]) {
				await page.setViewportSize({ width, height: 900 });
				await page.goto(localizeHref('/stop/S1', locale, 'stm') + period);
				const hourly = page.locator('#hourly');
				await expect(
					hourly.getByRole('columnheader', { name: locale === 'fr' ? '7 h' : '07h', exact: true }),
				).toBeVisible();
				await expect(
					hourly
						.getByRole('cell', {
							name: locale === 'fr' ? /6 h.*en retard/u : /06:00.*late/u,
						})
						.first(),
				).toBeVisible();
				await expect(page.locator('html')).toHaveJSProperty('scrollWidth', width);
				await page.goto(localizeHref('/stops', locale, 'stm') + period);
				const row = page
					.getByRole('table')
					.getByRole('row')
					.filter({ hasText: /Fixture stop/u });
				await expect(row.getByRole('link', { name: 'Fixture stop' })).toBeVisible();
				await expect(row).toContainText(locale === 'fr' ? /80,0\s+%/u : '80.0%');
				await page.getByTestId('stops-filter-input').fill('Fixture');
				await expect(page.getByRole('table').getByRole('rowheader')).toHaveCount(1);
				await expect(page.locator('html')).toHaveJSProperty('scrollWidth', width);
			}
		},
	);
