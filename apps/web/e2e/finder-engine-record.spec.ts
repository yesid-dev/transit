import { expect, test } from '@playwright/test';

test.use({ bypassCSP: true });
test.beforeEach(({ browserName }, info) => {
	test.skip(browserName !== 'chromium' || info.project.name !== 'desktop');
});

const query = 'provider=stm&frameMode=record&recordFrom=2026-11-08&recordTo=2026-11-14';

for (const locale of ['en', 'fr'] as const) {
	const fr = locale === 'fr';
	const prefix = fr ? '/fr' : '';

	test(`${locale} lines sort performance and keep schedule-only lines apart on phone and desktop`, async ({
		page,
		request,
	}) => {
		await page.setViewportSize({ width: 390, height: 900 });
		// Use the held trip-delivery fixture for the English visit to exercise streaming on one load.
		const dates = fr ? query : query.replace('2026-11-08', '2026-11-09');
		const response = await page.goto(`${prefix}/lines?${dates}`, { waitUntil: 'commit' });
		expect(response?.headers()['cache-control']).toBe('no-store, no-transform');
		const main = page.getByRole('main');
		const performance = main.getByRole('region', {
			name: fr ? 'Performance des lignes' : 'Line performance',
		});
		const timing = performance.getByRole('row', { name: /Sherbrooke/ });
		const scheduleOnly = main.getByRole('region', {
			name: fr ? 'Lignes sans données en direct' : 'Lines without live data',
		});

		if (!fr) {
			await test.step('punctuality streams while trip delivery is calculating', async () => {
				await expect(timing).toContainText('80%');
				await expect(
					performance.getByRole('status').filter({ hasText: 'Still working on this.' }),
				).toBeVisible();
				const dataPort = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';
				const release = await request.post(`http://127.0.0.1:${dataPort}/__overview/release`);
				expect(release.status()).toBe(204);
			});
		}

		await expect(timing).toContainText(fr ? '90 sur 105' : '90 of 105');
		await expect(timing).toContainText(fr ? 'Faible couverture' : 'Low coverage');
		await performance.getByLabel(fr ? 'Trier par' : 'Sort by').selectOption('onTime');
		await performance.getByText(fr ? 'Citer' : 'Cite', { exact: true }).click();
		const csv = await performance.getByRole('link', { name: /CSV/ }).getAttribute('href');
		expect(decodeURIComponent(csv!)).toContain('0.8,0.15,90,105,100');

		for (const width of [390, 1440]) {
			await test.step(`${width}px`, async () => {
				await page.setViewportSize({ width, height: 900 });
				await expect(timing).toContainText(fr ? /80\s%/ : '80%');
				await expect(timing).toContainText(fr ? '90 sur 105' : '90 of 105');
				await expect(
					performance
						.getByRole('cell', {
							name: fr ? 'Trop peu pour juger' : 'Too few to judge',
							exact: true,
						})
						.first(),
				).toBeVisible();
				await expect(performance.getByRole('rowheader').first()).toContainText('80');
				const rail = scheduleOnly.getByRole('link', { name: /Confederation/ });
				await expect(rail).toBeVisible();
				await expect(rail.locator('[data-slot="route-plate"]')).toHaveAttribute(
					'data-schedule-only',
					'true',
				);
				await expect(performance.getByRole('link', { name: /Confederation/ })).toHaveCount(0);
				await expect(
					scheduleOnly.getByText(fr ? 'Aucune donnée en direct' : 'No live data', { exact: true }),
				).toBeVisible();
				await expect(
					performance.getByRole('button', { name: fr ? 'Copier le lien' : 'Copy link' }),
				).toBeVisible();
				await expect(performance.getByText(/finder-timing-v1.*finder-delivery-v1/)).toBeVisible();
				expect(await main.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(width);
			});
		}
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
				await expect(results.getByText(/finder-timing-v1.*q=Fixture.*#stop-results/)).toBeVisible();
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
