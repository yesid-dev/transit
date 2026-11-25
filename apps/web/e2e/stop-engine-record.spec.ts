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
			const main = page.getByRole('main');
			const answer = main.locator('[data-slot="screen-answer"]');
			await expect(answer).toContainText(fr ? /80\s%/ : '80%');
			await expect(answer).toContainText(fr ? 'calcul précédent' : 'older answer');
			await expect(answer).toContainText(fr ? /10 points au-dessus/ : /1.2 points below/);
			await expect(main.getByRole('heading', { level: 1 })).toHaveCount(1);

			const bands = main.getByRole('article', {
				name: fr ? 'En avance, à l’heure et en retard' : 'Early, on time and late',
			});
			await expect(bands.getByRole('img')).toHaveAccessibleName(
				fr
					? /À l’heure: 80\s%, 6[ \u00a0\u202f]628 passages aux arrêts/
					: /On time: 80%, 6,628 stop events/,
			);
			await bands.getByRole('button', { name: fr ? 'Tableau' : 'Table', exact: true }).click();
			await expect(bands.getByRole('table')).toBeVisible();
			await bands.getByRole('button', { name: fr ? 'Graphique' : 'Chart', exact: true }).click();
			await expect(bands.getByRole('img')).toBeVisible();

			const grid = main.locator('#hourly');
			const hours = grid.getByRole('columnheader');
			await expect(hours).toHaveCount(20);
			await expect(hours.first()).toHaveText(fr ? '5 h' : '05h');
			await expect(hours.last()).toHaveText(fr ? '0 h' : '00h');
			await expect(grid).toContainText(fr ? /moins de 30 passages/ : 'under 30 stop events');
			await expect(grid.getByText(fr ? 'Non mesuré' : 'Not measured', { exact: true })).toHaveCount(
				0,
			);
			if (width === 1440) {
				await page.evaluate(() => document.fonts.ready);
				expect(
					await grid
						.locator('[data-slot="hour-grid"] [role="region"]')
						.evaluate((region) => region.scrollWidth - region.clientWidth),
				).toBe(0);
			}
			await expect(answer).toContainText(
				fr
					? /Ce qui est compté : 8[ \u00a0\u202f]285 passages/
					: 'Counted: 8,285 stop events, 230 trips, 7 days',
			);
			await expect(
				grid.getByRole('cell', { name: fr ? /lundi, 6 h.*en retard/ : /Monday, 06h.*late/ }),
			).toBeVisible();
			await expect(grid.locator('td:has([data-state="few"])').first()).toHaveAccessibleName(
				fr ? /trop peu de données.*23/ : /too few to judge.*23/,
			);
			await expect(grid.locator('td:has([data-state="none"])').first()).toHaveAccessibleName(
				fr ? /aucun service à cette heure/ : /no service at that hour/,
			);
			await expect(
				grid.locator('[data-state="few"][data-level], [data-state="none"][data-level]'),
			).toHaveCount(0);

			await expect(main.locator('#byLine')).toContainText(
				fr ? 'Trop peu de données' : 'Too few to judge',
			);
			await expect(main.locator('#byLine')).toContainText(
				fr ? '33 passages aux arrêts, le minimum est de 60' : '33 stop events, the minimum is 60',
			);
			await expect(
				main.locator('#daily [data-slot="chart-line-series"][data-reference]'),
			).toBeAttached();
			await expect(main.locator('#delay')).toContainText(fr ? '0,5 min d’avance' : '0.5 min early');
			await expect(main.locator('#delay')).toContainText(fr ? '5,8 min de retard' : '5.8 min late');
			await expect(main.locator('#alerts')).toContainText(fr ? 'Non suivi' : '3');
			await expect(main.locator('#accessibility')).toContainText(fr ? 'Non publié' : 'Accessible');

			const waiting = main.locator('#waiting');
			await expect(bands.locator('footer')).toContainText(
				fr
					? /8\s285 passages aux arrêts, 230 trajets, 7 jours/
					: '8,285 stop events, 230 trips, 7 days',
			);
			await expect(waiting.locator('footer').locator('span')).toHaveText(
				fr
					? ['27 intervalles observés, 7 jours', 'méthode v4, nettoyage v13']
					: ['27 observed intervals, 7 days', 'method v4, cleaning v13'],
			);
			await expect(main.locator('#daily footer span').first()).toHaveText(
				fr ? '700 passages aux arrêts, 7 jours' : '700 stop events, 7 days',
			);
			const alertsFooter = main.locator('#alerts footer');
			if (fr) await expect(alertsFooter).toBeHidden();
			else
				await expect(alertsFooter.locator('span')).toHaveText([
					'4 days',
					'method v5, cleaning v14',
				]);
			await expect(
				waiting.getByRole('row').filter({ has: page.getByRole('rowheader', { name: /\b80\b/ }) }),
			).toContainText(fr ? '24 intervalles observés' : '24 observed intervals');
			await expect(
				waiting.getByRole('row').filter({ has: page.getByRole('rowheader', { name: /\b24\b/ }) }),
			).toContainText(fr ? 'Trop peu pour juger' : 'Too few to judge');
			await expect(waiting.getByRole('rowheader', { name: /999$/ })).toHaveCount(0);
			await waiting.getByRole('button', { name: fr ? 'Définitions' : 'Definitions' }).click();
			await expect(
				waiting.getByText(
					fr ? /Attente observée moins attente prévue/ : /Observed wait minus scheduled wait/,
				),
			).toBeVisible();

			await expect(
				main.getByRole('button', { name: fr ? 'Copier le lien' : 'Copy link' }),
			).toHaveCount(1);
			await answer.getByRole('button', { name: fr ? 'Citer' : 'Cite', exact: true }).click();
			let sheet = page.getByRole('dialog');
			await expect(sheet.getByText(/v3.*#punctuality/)).toBeVisible();
			await expect(sheet.getByText(/#accessibility/)).toBeVisible();
			await sheet.getByRole('button', { name: fr ? 'Fermer' : 'Close' }).click();

			await answer
				.getByRole('button', { name: fr ? 'Télécharger' : 'Download', exact: true })
				.click();
			sheet = page.getByRole('dialog');
			await expect(sheet.getByRole('link')).toHaveCount(8);
			const accessCsv = await sheet
				.getByRole('link', {
					name: fr ? 'Embarquement en fauteuil roulant' : 'Wheelchair boarding',
				})
				.getAttribute('href');
			const download = await request.get(accessCsv!);
			expect(download.headers()['content-disposition']).toContain('stop-accessibility.csv');
			expect(await download.text()).toContain(`accessible_stops,${fr ? 0 : 1}`);
			const hourlyCsv = await sheet
				.getByRole('link', { name: fr ? 'Par heure' : 'By hour' })
				.getAttribute('href');
			expect(await (await request.get(hourlyCsv!)).text()).toBe(
				fr ? 'Mesure,Valeur\non_time,0.8\n' : 'Measure,Value\non_time,0.8\n',
			);
			await expect(page.locator('html')).toHaveJSProperty('scrollWidth', width);
		});
	}
}

test('the Stop answer streams while the per-line breakdown and hour grid are held', async ({
	page,
	request,
}) => {
	const path = '/stop/S1?provider=stm&frameMode=record&recordFrom=2026-11-09&recordTo=2026-11-15';
	const response = await page.goto(path, { waitUntil: 'commit' });
	expect(response?.headers()['cache-control']).toBe('no-store, no-transform');
	await expect(page.locator('[data-slot="screen-answer"]')).toContainText('80%');
	await expect(page.locator('#hourly')).toContainText('Calculating');
	await expect(page.locator('[data-slot="record-patience"]')).toContainText(
		'These records take longer',
	);
	const dataPort = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';
	for (const fixture of ['stop-by-line', 'stop-hour-grid']) {
		expect(
			(
				await request.post(`http://127.0.0.1:${dataPort}/__overview/release?fixture=${fixture}`)
			).status(),
		).toBe(204);
	}
	await expect(page.locator('#byLine')).toContainText('Too few to judge');
	await expect(page.locator('#hourly [data-slot="hour-grid"]')).toBeVisible();
});
