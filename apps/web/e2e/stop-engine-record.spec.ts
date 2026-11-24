import { expect, test } from '@playwright/test';

test.use({ bypassCSP: true });

test.beforeEach(({ browserName }, info) => {
	test.skip(browserName !== 'chromium' || info.project.name !== 'desktop');
});

for (const width of [390, 1440]) {
	for (const locale of ['en', 'fr'] as const) {
		const fr = locale === 'fr';
		test(`${locale} at ${width}px shows the Stop record with evidence`, async ({
			page,
			request,
		}) => {
			await page.setViewportSize({ width, height: 900 });
			const path = `${fr ? '/fr' : ''}/stop/S1?provider=${fr ? 'octranspo' : 'stm'}&frameMode=record`;
			await page.goto(`${path}&recordFrom=2026-11-08&recordTo=2026-11-14`);
			await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
			const waiting = page.getByRole('region', {
				name: fr ? 'Attente par ligne' : 'Waiting by line',
				exact: true,
			});
			await expect(
				waiting.getByRole('row').filter({ has: page.getByRole('rowheader', { name: /80$/ }) }),
			).toContainText(fr ? '24 intervalles observés' : '24 observed intervals');
			await expect(
				waiting.getByRole('row').filter({ has: page.getByRole('rowheader', { name: /^24\b/ }) }),
			).toContainText(fr ? 'Trop peu pour juger' : 'Too few to judge');
			await expect(waiting.getByRole('rowheader', { name: /999$/ })).toHaveCount(0);
			const main = page.getByRole('main');
			const section = (name: string) => main.getByRole('region', { name, exact: true });
			const punctuality = section(fr ? 'Ponctualité' : 'On-time performance');
			await expect(punctuality).toContainText(
				fr ? /du 8 au 14 nov\. 2026, 80\s%.*80 sur 100/ : /8 to 14 Nov 2026, 80%.*80 of 100/,
				{ timeout: 15_000 },
			);
			await expect(punctuality).toContainText(fr ? 'calcul précédent' : 'older answer');
			for (const band of fr
				? ['En avance', 'À l’heure', 'En retard']
				: ['Early', 'On time', 'Late']) {
				await expect(punctuality.getByText(band, { exact: true })).toBeVisible();
			}
			await expect(section(fr ? 'Par ligne' : 'By line')).toContainText(
				fr ? 'Trop peu pour juger' : 'Too few to judge',
			);
			await expect(
				section(fr ? 'Par heure' : 'By hour').getByRole('rowheader', {
					name: '07:00',
					exact: true,
				}),
			).toBeVisible();
			await expect(section(fr ? 'Jour par jour' : 'Day by day').getByRole('rowheader')).toHaveCount(
				1,
			);
			const delay = section(fr ? 'Retard typique' : 'Typical delay');
			await expect(delay).toContainText(fr ? '0,5 min d’avance' : '0.5 min early');
			await expect(delay).toContainText(fr ? '5,8 min de retard' : '5.8 min late');
			const alerts = section(fr ? 'Avis pour cet arrêt' : 'Alerts for this stop');
			await expect(alerts.getByText(fr ? 'Non suivi' : '3', { exact: true })).toBeVisible();
			const access = section(fr ? 'Embarquement en fauteuil roulant' : 'Wheelchair boarding');
			await expect(
				access.getByText(fr ? 'Aucune information' : 'Accessible', { exact: true }),
			).toBeVisible();
			await access.getByText(fr ? 'Citer' : 'Cite', { exact: true }).click();
			await expect(access.getByText(/#accessibility/)).toBeVisible();
			const accessCsv = await access.getByRole('link', { name: /CSV/ }).getAttribute('href');
			const download = await request.get(accessCsv!);
			expect(download.headers()['content-disposition']).toContain('stop-accessibility.csv');
			expect(await download.text()).toContain(`accessible_stops,${fr ? 0 : 1}`);

			await expect(
				punctuality.getByRole('button', { name: fr ? 'Copier le lien' : 'Copy link' }),
			).toBeVisible();
			await punctuality.getByText(fr ? 'Citer' : 'Cite', { exact: true }).click();
			await expect(punctuality.getByText(/v1.*#punctuality/)).toBeVisible();
			const csv = await punctuality.getByRole('link', { name: /CSV/ }).getAttribute('href');
			const response = await request.get(csv!);
			expect(response.ok()).toBeTruthy();
			expect(await response.text()).toMatch(fr ? /^Mesure,Valeur/ : /^Measure,Value/);
			expect(await main.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(width);

			if (!fr && width === 1440) {
				const view = main.getByRole('navigation', { name: 'Stop views' });
				await view.getByRole('link', { name: 'Live now' }).click();
				await expect(page).toHaveURL(/frameMode=live.*tab=detail/);
				await expect(main.getByRole('heading', { name: 'Predictions at this stop' })).toBeVisible();
				await expect(main.getByRole('heading', { name: /^Agency notices/ })).toBeVisible();
				await main.getByRole('link', { name: 'See the record' }).click();
				await expect(page).toHaveURL(/frameMode=record.*recordFrom=2026-11-08/);
				await expect(punctuality).toContainText('80 of 100');
			}
		});
	}
}

test('a slow per-line breakdown does not hold back the Stop answer', async ({ page, request }) => {
	const path = '/stop/S1?provider=stm&frameMode=record&recordFrom=2026-11-09&recordTo=2026-11-15';
	const response = await page.goto(path, { waitUntil: 'commit' });
	expect(response?.headers()['cache-control']).toBe('no-store, no-transform');
	await expect(page.getByText(/^9 to 15 Nov 2026, 80%.*80 of 100/)).toBeVisible();
	const byLine = page.getByRole('region', { name: 'By line', exact: true });
	await expect(page.locator('[data-slot="record-patience"]')).toContainText(
		'These records take longer',
	);
	await expect(page.getByRole('region', { name: 'Alerts for this stop' })).toContainText(
		'The record is busy right now. You can come back later.',
	);
	const dataPort = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';
	expect(
		(
			await request.post(`http://127.0.0.1:${dataPort}/__overview/release?fixture=stop-by-line`)
		).status(),
	).toBe(204);
	await expect(byLine).toContainText('Too few to judge');
});
