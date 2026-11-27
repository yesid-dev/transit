import { expect, test } from '@playwright/test';
import { closeCompactFrameControls, openFrameControls } from './frame-controls';

const cases = [
	{ screen: '/', city: 'stm', locale: 'en', width: 1440, theme: 'light' },
	{ screen: '/network', city: 'stm', locale: 'fr', width: 1440, theme: 'dark' },
	{ screen: '/lines', city: 'octranspo', locale: 'en', width: 390, theme: 'light' },
	{ screen: '/lines/51', city: 'stm', locale: 'fr', width: 390, theme: 'dark' },
] as const;

test.describe('unpublished Yesterday', () => {
	test.beforeEach(({ browserName }, info) => {
		test.skip(browserName !== 'chromium' || info.project.name !== 'desktop');
	});

	for (const { screen, city, locale, width, theme } of cases) {
		test(`${screen} shows the last built day in ${locale} at ${width}px`, async ({ page }) => {
			const fr = locale === 'fr';
			const prefix = fr ? '/fr' : '';
			const href = `${prefix}${screen}?provider=${city}&frameMode=record`;
			await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
			await page.emulateMedia({ colorScheme: theme });
			await page.addInitScript((value) => localStorage.setItem('theme', value), theme);
			await page.setExtraHTTPHeaders({ 'x-transit-fixture-scope': 'record-yesterday' });
			await page.clock.setFixedTime(new Date('2026-11-27T05:05:00Z'));
			await page.goto(href + '&period=yesterday&recordFrom=2026-11-26&recordTo=2026-11-26');

			const main = page.getByRole('main');
			const notice = main.locator('[data-slot="record-start-notice"]');
			await expect(notice).toHaveCount(1);
			await expect(notice).toHaveText(
				fr
					? 'Le 26 novembre ne figure pas encore au bilan. Affichage du 25 novembre.'
					: '26 November is not in the record yet. Showing 25 November.',
			);
			await expect(
				main
					.getByText(fr ? 'Bilan · 25 nov. 2026' : 'Record · 25 Nov 2026', { exact: true })
					.first(),
			).toBeVisible();
			const rail = await openFrameControls(page, locale);
			await expect(
				rail.getByRole('radio', { name: fr ? 'Hier' : 'Yesterday', exact: true }),
			).toBeChecked();
			await expect(
				rail.getByText(fr ? /25 nov\. 2026 · 1 jour/ : /25 Nov 2026 · 1 day/),
			).toBeVisible();
			await closeCompactFrameControls(page, locale);
		});
	}
});
