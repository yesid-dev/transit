import { expect, test } from '@playwright/test';

test.use({ bypassCSP: true });
test.beforeEach(({ browserName }, info) => {
	test.skip(browserName !== 'chromium' || info.project.name !== 'desktop');
});

const query = 'provider=stm&frameMode=record&recordFrom=2026-11-08&recordTo=2026-11-14';

for (const width of [390, 1440]) {
	for (const locale of ['en', 'fr']) {
		const fr = locale === 'fr';
		const prefix = fr ? '/fr' : '';
		test(`${locale} at ${width}px sorts line performance and keeps schedule-only lines apart`, async ({
			page,
		}) => {
			await page.setViewportSize({ width, height: 900 });
			const response = await page.goto(`${prefix}/lines?${query}`);
			expect(response?.headers()['cache-control']).toBe('no-store, no-transform');
			const performance = page.getByRole('region', {
				name: fr ? 'Performance des lignes' : 'Line performance',
			});
			const timing = performance.getByRole('row', { name: /Sherbrooke/ });
			await expect(timing).toContainText(fr ? /80\s%/ : '80%');
			await expect(timing).toContainText(fr ? '90 sur 105' : '90 of 105');
			await expect(
				performance
					.getByRole('cell', { name: fr ? 'Trop peu pour juger' : 'Too few to judge', exact: true })
					.first(),
			).toBeVisible();
			await performance.getByLabel(fr ? 'Trier par' : 'Sort by').selectOption('onTime');
			await expect(performance.getByRole('rowheader').first()).toContainText('80');
			const scheduleOnly = page.getByRole('region', {
				name: fr ? 'Lignes sans données en direct' : 'Lines without live data',
			});
			await expect(scheduleOnly.getByRole('link', { name: /Confederation/ })).toBeVisible();
			await expect(performance.getByRole('link', { name: /Confederation/ })).toHaveCount(0);
			await expect(
				scheduleOnly.getByText(fr ? 'Aucune donnée en direct' : 'No live data', { exact: true }),
			).toBeVisible();
			await expect(
				performance.getByRole('button', { name: fr ? 'Copier le lien' : 'Copy link' }),
			).toBeVisible();
			await performance.getByText(fr ? 'Citer' : 'Cite', { exact: true }).click();
			await expect(performance.getByText(/finder-timing-v1.*finder-delivery-v1/)).toBeVisible();
			const csv = await performance.getByRole('link', { name: /CSV/ }).getAttribute('href');
			expect(decodeURIComponent(csv!)).toContain('0.8,0.15,90,105,100');
			expect(
				await page.getByRole('main').evaluate((element) => element.scrollWidth),
			).toBeLessThanOrEqual(width);
		});

		test(`${locale} at ${width}px searches stops and shows their records for the selected dates`, async ({
			page,
		}) => {
			await page.setViewportSize({ width, height: 900 });
			const response = await page.goto(`${prefix}/stops?${query}&q=Fixture`);
			expect(response?.headers()['cache-control']).toBe('no-store, no-transform');
			const results = page.getByRole('region', {
				name: fr ? 'Résultats de recherche d’arrêts' : 'Stop results',
				exact: true,
			});
			const row = results.getByRole('row', { name: /Fixture stop/ });
			await expect(row).toContainText(fr ? /80\s%/ : '80%');
			await expect(row).toContainText('100');
			await expect(row.getByRole('link')).toHaveAttribute(
				'href',
				/\/stop\/S1.*recordFrom=2026-11-08.*recordTo=2026-11-14/,
			);
			await results.getByText(fr ? 'Citer' : 'Cite', { exact: true }).click();
			await expect(results.getByText(/finder-timing-v1.*q=Fixture.*#stop-results/)).toBeVisible();
			const csv = await results.getByRole('link', { name: /CSV/ }).getAttribute('href');
			expect(decodeURIComponent(csv!)).toContain('"Fixture stop",0.8,100,80');
			await expect(
				page.getByRole('link', { name: fr ? 'Près d’une adresse' : 'Near an address' }),
			).toBeVisible();
			await page.getByTestId('stops-filter-input').fill('No such stop');
			await expect(row).toHaveCount(0);
			expect(
				await page.getByRole('main').evaluate((element) => element.scrollWidth),
			).toBeLessThanOrEqual(width);
		});
	}
}

test('line punctuality appears while trip delivery is still calculating', async ({
	page,
	request,
}) => {
	await page.goto('/lines?' + query.replace('2026-11-08', '2026-11-09'), { waitUntil: 'commit' });
	const row = page.getByRole('row', { name: /Sherbrooke/ });
	await expect(row).toContainText('80%');
	await expect(
		page.getByRole('status').filter({ hasText: 'Still working on this.' }),
	).toBeVisible();
	const dataPort = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';
	expect((await request.post(`http://127.0.0.1:${dataPort}/__overview/release`)).status()).toBe(
		204,
	);
	await expect(row).toContainText('90 of 105');
});
