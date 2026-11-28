import { csvText } from '../src/tests/csv';
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
					// Content is drawn on the server; controls answer once the page has hydrated.
					await expect(page.locator('html[data-hydrated]')).toBeAttached();
					const section = page.locator('#punctuality');
					await expect(section).toContainText(fr ? /80,0\s%/u : '80.0%');
					await section.getByRole('button', { name: fr ? 'Télécharger' : 'Download' }).click();
					const csv = page
						.getByRole('dialog')
						.getByRole('link', { name: fr ? 'Ponctualité' : 'On-time share', exact: true });
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
					expect(download.suggestedFilename()).toBe(
						`${provider}-line-24-punctuality-2026-11-08-to-2026-11-14-${locale}.csv`,
					);
					// Every row ends with the source and licence; the fixture city declares no licence name.
					const source = fr
						? `Données ouvertes ${provider === 'stm' ? 'de la STM' : 'd’OC Transpo'}, calculs de Transit`
						: `${provider === 'stm' ? 'STM' : 'OC Transpo'} open data, computed by Transit`;
					expect(csvText(readFileSync((await download.path())!))).toBe(
						(fr
							? 'Identifiant de la mesure,Mesure,Valeur,Source des données et licence,Adresse de la licence'
							: 'Measure ID,Measure,Value,Data source and licence,Licence URL') +
							`\r\npunctuality,punctuality,0.8,"${source}",\r\n`,
					);
					expect(new URL(page.url()).pathname).toBe((fr ? '/fr' : '') + '/lines/24');
					expect(snapshotRequests).toEqual([]);
					if (width === 390)
						expect(
							(await new AxeBuilder({ page }).include('#punctuality').analyze()).violations,
						).toEqual([]);
				},
			);
