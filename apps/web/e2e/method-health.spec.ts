import { expect, test } from '@playwright/test';
import { textDefects } from './layout-helpers';

test.beforeEach(({ browserName }, info) => {
	test.skip(browserName !== 'chromium' || info.project.name !== 'desktop');
});

for (const width of [390, 1440]) {
	for (const locale of ['en', 'fr']) {
		const fr = locale === 'fr';
		const path = fr ? '/fr' : '';
		const provider = fr ? 'octranspo' : 'stm';
		const dates = `provider=${provider}&recordFrom=2026-11-11&recordTo=2026-11-14`;

		test(`How we measure in ${locale} at ${width}px`, async ({ page, request }) => {
			await page.setViewportSize({ width, height: 900 });
			await page.goto(`${path}/metrics?${dates}#fixture_delay`);
			const main = page.getByRole('main');
			await expect(main.getByRole('heading', { level: 1 })).toHaveText(
				fr ? 'Comment on mesure' : 'How we measure',
			);
			const heading = await main.getByRole('heading', { level: 1 }).boundingBox();
			const intro = await main.locator('[data-slot="answer-lead"] p').first().boundingBox();
			expect(intro!.x).toBeCloseTo(heading!.x);
			const measure = main.locator('#fixture_delay');
			await expect(measure).toHaveAttribute('open', '');
			await expect(measure).toContainText(fr ? 'tranches de 15 s' : '15-s steps');
			await expect(measure.getByText(/^v2, /)).toBeVisible();
			await expect(measure.locator('time')).toHaveText(
				fr ? '10 novembre 2026' : '10 November 2026',
			);
			const disclosures = main.locator('details[data-record-disclosure]');
			for (const card of await disclosures.all()) {
				const trigger = card.locator('summary').first();
				if (await trigger.isVisible()) {
					const initiallyOpen = (await card.getAttribute('open')) !== null;
					await trigger.press('Enter');
					expect((await card.getAttribute('open')) !== null).toBe(!initiallyOpen);
					await trigger.press('Space');
					expect((await card.getAttribute('open')) !== null).toBe(initiallyOpen);
				}
			}
			await main.getByRole('button', { name: fr ? 'Tout replier' : 'Collapse all' }).click();
			await expect(main.locator('details[data-record-disclosure][open]')).toHaveCount(0);
			await expect(
				main.getByRole('group', { name: fr ? 'Actions du bilan' : 'Record actions' }),
			).toHaveCount(1);

			await main.getByRole('button', { name: fr ? 'Citer' : 'Cite', exact: true }).click();
			await expect(page.getByRole('dialog').getByText(/v2.*\/metrics#fixture_delay/)).toBeVisible();
			await page.keyboard.press('Escape');
			await main
				.getByRole('button', { name: fr ? 'Télécharger' : 'Download', exact: true })
				.click();
			const dialog = page.getByRole('dialog');
			await dialog
				.getByText(fr ? 'Colonnes du CSV' : 'CSV columns', { exact: false })
				.first()
				.click();
			await expect(dialog.getByText(fr ? 'Valeur' : 'Value', { exact: true })).toBeVisible();
			const csvUrl = (await dialog
				.getByRole('link', {
					name: fr ? 'Retard typique aux arrêts observés' : 'Typical delay at recorded stops',
				})
				.getAttribute('href'))!;
			await page.keyboard.press('Escape');
			expect(new URL(csvUrl, page.url()).searchParams.get('provider')).toBe(provider);
			const csv = await request.get(csvUrl);
			expect(csv.ok()).toBe(true);
			expect(await csv.text()).toMatch(fr ? /^Mesure,Valeur/ : /^Measure,Value/);
			expect(await main.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(width);
			if (fr && width === 1440) {
				await page.goto(`${path}/metrics?provider=${provider}#otp`);
				await expect(page).toHaveURL(/\/fr\/metrics\/archive\?provider=octranspo#otp$/);
				await expect(main.locator('#otp')).toBeAttached();
			}
		});

		test(`Data health in ${locale} at ${width}px`, async ({ page }) => {
			await page.setViewportSize({ width, height: 900 });
			const response = await page.goto(`${path}/status?${dates}`);
			expect(response?.headers()['cache-control']).toBe('no-store, no-transform');
			const main = page.getByRole('main');
			await expect(main.getByRole('heading', { level: 1 })).toHaveText(
				fr ? 'Santé des données' : 'Data health',
			);
			const table = main.getByRole('table');
			await expect(table.getByRole('rowheader')).toHaveCount(4);
			for (const state of fr
				? [
						'Présent',
						'Incomplet',
						'Manquant (Fichier manquant)',
						'Non mesuré (Aucune capture brute)',
						'Non mesuré (Aucune édition de l’horaire)',
					]
				: [
						'Present',
						'Incomplete',
						'Missing (File missing)',
						'Not measured (No raw captures)',
						'Not measured (No schedule edition)',
					]) {
				await expect(table.getByRole('cell', { name: state, exact: true }).first()).toBeAttached();
			}
			await expect(main.getByRole('link', { name: /CSV/ })).toHaveCount(0);
			await expect(
				main.getByRole('button', { name: fr ? 'Copier le lien' : 'Copy link' }),
			).toBeVisible();
			await main.getByText(fr ? 'Citer' : 'Cite', { exact: true }).click();
			await expect(main.getByText(/recordFrom=2026-11-11.*#table-health/)).toBeVisible();
			const tableHealthDefects = (await textDefects(page)).filter(({ selector }) =>
				selector.startsWith('#table-health'),
			);
			expect(tableHealthDefects).toEqual([]);
			await expect(main.getByText('v2', { exact: true })).toBeVisible();
			expect(await main.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(width);
		});
	}
}
