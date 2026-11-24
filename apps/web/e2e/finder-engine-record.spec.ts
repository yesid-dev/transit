import { expect, test } from '@playwright/test';

test.use({ bypassCSP: true });
test.beforeEach(({ browserName }, info) => {
	test.skip(browserName !== 'chromium' || info.project.name !== 'desktop');
});

const query = 'provider=stm&frameMode=record&recordFrom=2026-11-08&recordTo=2026-11-14';

for (const locale of ['en', 'fr'] as const) {
	const fr = locale === 'fr';
	const prefix = fr ? '/fr' : '';

	test(`${locale} lines stream their readings and retain both CSV files`, async ({
		page,
		request,
	}) => {
		const dates = fr ? query : query.replace('2026-11-08', '2026-11-09');
		const response = await page.goto(`${prefix}/lines?${dates}`, { waitUntil: 'commit' });
		expect(response?.headers()['cache-control']).toBe('no-store, no-transform');

		const measured = page.getByRole('table', {
			name: fr ? 'Toutes les lignes mesurées' : 'Every measured line',
		});
		const timing = measured.getByRole('row', { name: /Sherbrooke/ });
		await expect(timing).toContainText(fr ? /80\s%/ : '80%');
		await expect(timing).toContainText(fr ? 'Faible couverture' : 'Low coverage');
		if (!fr) {
			await expect(page.locator('[data-slot="record-patience"]').getByRole('status')).toBeVisible();
			const dataPort = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';
			const release = await request.post(`http://127.0.0.1:${dataPort}/__overview/release`);
			expect(release.status()).toBe(204);
		}
		await expect(timing).toContainText(fr ? '90 sur 105' : '90 of 105');

		const scheduleOnly = page.getByRole('table', {
			name: fr ? 'Lignes sans données en direct' : 'Lines without live data',
		});
		await expect(
			scheduleOnly.getByRole('row', { name: /Confederation/ }).locator('[data-slot="route-plate"]'),
		).toHaveAttribute('data-schedule-only', 'true');
		await expect(measured.getByRole('link', { name: /Confederation|99/ })).toHaveCount(0);
		await page.getByRole('button', { name: fr ? 'Télécharger' : 'Download', exact: true }).click();
		const sheet = page.getByRole('dialog', {
			name: fr ? 'Télécharger les fichiers CSV' : 'Download the CSV files',
		});
		const csv = sheet.getByRole('link', {
			name: fr ? 'Performance des lignes' : 'Line performance',
		});
		expect(decodeURIComponent((await csv.getAttribute('href'))!)).toContain('0.8,0.15,90,105,100');
		await expect(
			sheet.getByRole('link', {
				name: fr ? 'Lignes sans données en direct' : 'Lines without live data',
			}),
		).toHaveAttribute('download', /^lines-without-live-data-.*\.csv$/);
	});

	test(`${locale} lines page and sort from the address, with keyboard access and copy`, async ({
		page,
		context,
	}) => {
		await context.grantPermissions(['clipboard-read', 'clipboard-write']);
		await page.setViewportSize({ width: 390, height: 900 });
		const dates = query.replace('2026-11-08', '2026-11-04');
		await page.goto(`${prefix}/lines?${dates}&sort=onTime&direction=desc`);
		const table = page.getByRole('table', {
			name: fr ? 'Toutes les lignes mesurées' : 'Every measured line',
		});
		await expect(table.getByRole('link')).toHaveCount(20);
		await expect(table.getByRole('link').first()).toHaveAttribute('href', /\/lines\/324\?/);
		const more = page.getByRole('button', {
			name: fr ? 'Afficher 5 de plus' : 'Show 5 more',
			exact: true,
		});
		await more.focus();
		await page.keyboard.press('Enter');
		await expect(table.getByRole('link')).toHaveCount(25);
		await expect(
			table.getByRole('row').filter({ has: page.locator('a[href*="/lines/304?"]') }),
		).toBeFocused();

		await page.getByRole('radio', { name: fr ? 'Numéro de ligne' : 'Line number' }).click();
		await expect(page).toHaveURL(/sort=line&direction=asc$/);
		await expect(table.getByRole('link')).toHaveCount(20);
		await expect(table.getByRole('link').first()).toHaveAttribute('href', /\/lines\/300\?/);
		await page
			.getByRole('button', { name: fr ? 'Copier le lien' : 'Copy link', exact: true })
			.click();
		expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
			'sort=line&direction=asc',
		);
		await page.goBack();
		await expect(table.getByRole('link').first()).toHaveAttribute('href', /\/lines\/324\?/);

		const excluded = page.getByRole('table', {
			name: fr
				? 'Lignes impossibles à évaluer pour ces dates'
				: 'Lines that cannot be judged on these dates',
		});
		for (const state of ['too_few_to_judge', 'not_measured', 'unknown']) {
			const cell = excluded.locator(`[data-record-state="${state}"]`).locator('..').first();
			await expect(cell).toBeVisible();
			await expect(cell).not.toContainText(/\b0%?\b/);
		}
		await expect(excluded).toContainText(fr ? 'sur un minimum de 500' : 'the minimum is 500');
	});

	test(`${locale} lines distinguish a failed connection from a busy engine`, async ({ page }) => {
		await page.goto(`${prefix}/lines?${query.replace('2026-11-08', '2026-11-05')}`);
		const unavailable = fr
			? 'Le bilan est temporairement indisponible.'
			: 'The record is temporarily unavailable.';
		await expect(page.locator('[data-slot="screen-answer"]')).toContainText(unavailable);
		await expect(page.locator('#line-performance').getByText(unavailable)).toHaveCount(1);
		await expect(page.locator('#line-performance tbody tr')).toHaveCount(0);

		await page.goto(`${prefix}/lines?${query.replace('2026-11-08', '2026-11-06')}`);
		await expect(page.locator('[data-slot="record-patience"]').getByRole('status')).toHaveCount(1);
		await expect(page.getByRole('main').getByText(unavailable)).toHaveCount(0);
	});

	test(`${locale} stops show period records and filter search results on phone and desktop`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 900 });
		const response = await page.goto(`${prefix}/stops?${query}&q=Fixture`);
		expect(response?.headers()['cache-control']).toBe('no-store, no-transform');
		const main = page.getByRole('main');
		const results = main.getByRole('region', {
			name: fr ? 'Résultats de recherche d’arrêts' : 'Stop results',
			exact: true,
		});
		const row = results.getByRole('row', { name: /Fixture stop/ });
		const filter = page.getByTestId('stops-filter-input');
		for (const width of [390, 1440]) {
			await test.step(`${width}px`, async () => {
				await page.setViewportSize({ width, height: 900 });
				await expect(row).toContainText(fr ? /80\s%/ : '80%');
				await expect(row).toContainText('100');
				await expect(row).toContainText(
					fr ? 'des 250 passages prévus observés' : 'of 250 scheduled stops observed',
				);
				await expect(row.getByRole('link')).toHaveAttribute(
					'href',
					/\/stop\/S1.*recordFrom=2026-11-08.*recordTo=2026-11-14/,
				);
				await results.getByText(fr ? 'Citer' : 'Cite', { exact: true }).click();
				await expect(
					results.getByText(
						fr
							? /Méthode v1, nettoyage v8\..*q=Fixture.*#stop-results/
							: /Method v1, cleaning v8\..*q=Fixture.*#stop-results/,
					),
				).toBeVisible();
				const csv = await results.getByRole('link', { name: /CSV/ }).getAttribute('href');
				expect(decodeURIComponent(csv!)).toContain('"Fixture stop",0.8,100,80');
				await expect(
					main.getByRole('link', { name: fr ? 'Près d’une adresse' : 'Near an address' }),
				).toBeVisible();
				await filter.fill('No such stop');
				await expect(row).toHaveCount(0);
				expect(await main.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(width);
				if (width === 390) await filter.fill('Fixture');
			});
		}
	});
}
