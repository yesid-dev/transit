import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { localizeHref } from '../src/lib/i18n/routing';

test.use({ bypassCSP: true });

for (const provider of ['stm', 'octranspo'])
	for (const locale of ['en', 'fr'] as const)
		for (const width of [320, 390, 768, 1280])
			test(
				provider + ' ' + locale + ' ' + width + ': engine CSV preserves measure, period and values',
				async ({ page }) => {
					const fr = locale === 'fr';
					const path = localizeHref('/lines/24', locale, provider);
					await page.setViewportSize({ width, height: 1000 });
					const snapshotRequests: string[] = [];
					page.on('request', (request) => {
						if (/\/v1\//u.test(request.url())) snapshotRequests.push(request.url());
					});
					await page.goto(path + '&recordFrom=2026-11-08&recordTo=2026-11-14');
					const section = page.locator('#punctuality');
					await expect(section.locator('dl').getByText(/80\s?% \(80\/100\)/u)).toBeVisible();
					const csv = section.getByRole('link', { name: /CSV/u });
					const href = new URL((await csv.getAttribute('href'))!, page.url());
					expect(href.pathname).toBe((fr ? '/fr' : '') + '/lines/24/record.csv');
					expect(Object.fromEntries(href.searchParams)).toMatchObject({
						provider,
						section: 'punctuality',
						recordFrom: '2026-11-08',
						recordTo: '2026-11-14',
					});
					await csv.focus();
					await expect(csv).toBeFocused();
					expect((await csv.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
					const pending = page.waitForEvent('download');
					await csv.press('Enter');
					const download = await pending;
					expect(download.suggestedFilename()).toBe('line-punctuality.csv');
					expect(readFileSync((await download.path())!, 'utf8')).toBe(
						(fr ? 'Mesure,Valeur' : 'Measure,Value') + '\npunctuality,0.8\n',
					);
					expect(new URL(page.url()).pathname).toBe((fr ? '/fr' : '') + '/lines/24');
					expect(snapshotRequests).toEqual([]);
					if (width === 390)
						expect(
							(await new AxeBuilder({ page }).include('#punctuality').analyze()).violations,
						).toEqual([]);
				},
			);
