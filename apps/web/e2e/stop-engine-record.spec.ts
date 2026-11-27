import { csvText } from '../src/tests/csv';
import { expect, test } from '@playwright/test';

test.use({ bypassCSP: true });

test.beforeEach(({ browserName }, info) => {
	test.skip(browserName !== 'chromium' || info.project.name !== 'desktop');
});

test('a stop with no eligible days shows the network alone and explains the missing line', async ({
	page,
}) => {
	await page.goto(
		'/stop/S1?provider=stm&frameMode=record&recordFrom=2026-11-08&recordTo=2026-11-11',
	);
	const daily = page.locator('#daily');
	await expect(
		daily.getByText('Too few stop events per day to draw this stop’s line (minimum 30 per day).'),
	).toBeVisible();
	await expect(daily.locator('[data-slot="chart-line-series"][data-reference]')).toHaveCount(1);
	await expect(daily.locator('[data-slot="chart-line-series"]:not([data-reference])')).toHaveCount(
		0,
	);
	await expect(daily.getByText('On-time share', { exact: true })).toHaveCount(0);
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
			await expect(answer).toContainText(fr ? /80,0\s%/ : '80.0%');
			await expect(answer).toContainText(fr ? 'calcul précédent' : 'older answer');
			await expect(answer).toContainText(fr ? /10 points au-dessus/ : /1.2 points below/);
			await expect(main.getByRole('heading', { level: 1 })).toHaveCount(1);
			const delivery = main.getByRole('article', {
				name: fr ? 'Trajets effectués à cet arrêt' : 'Trips that ran at this stop',
			});
			await expect(delivery).toContainText(fr ? /96,0\s%/u : '96.0%');
			await expect(delivery).toContainText(
				fr ? '96 des 100 trajets à l’état connu' : '96 of the 100 trips with a known status',
			);
			await expect(delivery).toContainText(
				fr ? /entre 87,3\s% et 96,4\s%/u : 'between 87.3% and 96.4%',
			);
			await expect(
				delivery.locator('dl > div').filter({ hasText: fr ? 'Annulés' : 'Cancelled' }),
			).toContainText('3');
			await expect(
				delivery.locator('dl > div').filter({ hasText: fr ? 'Trajets ajoutés' : 'Added trips' }),
			).toContainText('2');
			await expect(delivery).toContainText(
				fr
					? 'Part des trajets prévus à l’issue connue qui ont été effectués.'
					: 'Share of scheduled trips with a known outcome that ran.',
			);
			await expect(delivery).toContainText(
				fr ? 'L’issue s’applique au trajet entier.' : 'An outcome applies to the whole trip.',
			);

			const bands = main.getByRole('article', {
				name: fr ? 'En avance, à l’heure et en retard' : 'Early, on time and late',
			});
			await expect(bands.getByRole('img')).toHaveAccessibleName(
				fr
					? /À l’heure: 80,0\s%, 6[ \u00a0\u202f]628 passages aux arrêts/
					: /On time: 80\.0%, 6,628 stop events/,
			);
			const tableToggle = bands.getByRole('button', {
				name: fr ? 'Tableau' : 'Table',
				exact: true,
			});
			await tableToggle.click();
			await expect(bands.getByRole('table')).toBeVisible();
			await tableToggle.click();
			await expect(bands.getByRole('img')).toBeVisible();

			const grid = main.locator('#hourly');
			const hours = grid.getByRole('columnheader');
			await expect(hours).toHaveCount(20);
			await expect(hours.first()).toHaveText(fr ? '5 h' : '05h');
			await expect(hours.last()).toHaveText(fr ? '0 h' : '00h');
			await expect(grid).toContainText(fr ? 'Les heures après minuit' : 'Hours after midnight');
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
					? /Ce qui est compté\s:\s8[ \u00a0\u202f]285 passages/u
					: 'Counted: 8,285 stop events, 230 observed trips, 7 days',
			);
			const sixOClock = grid.getByRole('cell', {
				name: fr
					? 'lundi, 6 h : 33,0 % en retard, 106 passages aux arrêts'
					: 'Monday, 06:00: 33.0% late, 106 stop events',
				exact: true,
			});
			await expect(sixOClock).toBeVisible();
			await expect(sixOClock).toHaveText('33');
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
			const daily = main.locator('#daily');
			await expect(
				daily.locator('[data-slot="chart-line-series"]:not([data-reference]) polyline'),
			).toHaveCount(2);
			await expect(
				daily.getByText(fr ? /minimum de 30 par jour/ : /minimum 30 per day/),
			).toHaveCount(1);
			await expect(daily.locator('svg text').filter({ hasText: /^(?:0|20)\s?%$/ })).toHaveCount(1);
			await expect(main.locator('#delay')).toContainText(fr ? '0,5 min d’avance' : '0.5 min early');
			await expect(main.locator('#delay')).toContainText(fr ? '5,8 min de retard' : '5.8 min late');
			await expect(main.locator('#alerts')).toContainText(fr ? 'Non suivi' : '3');
			await expect(main.locator('#accessibility')).toContainText(fr ? 'Non publié' : 'Accessible');
			await expect(
				main.getByRole('link', { name: fr ? 'Vous avez vu une erreur?' : 'Seen an error?' }),
			).toHaveAttribute('href', /\/metrics\?.*#about-transit$/u);

			const waiting = main.locator('#waiting');
			const waitingLine = waiting.getByRole('row').filter({
				has: page.getByRole('rowheader', { name: /\b80\b/ }),
			});
			if (width === 390) {
				for (const card of [main.locator('#byLine'), waiting]) {
					const frame = card.locator('[data-slot="data-table-frame"]');
					await expect(frame).toHaveAttribute('data-responsive', 'rows');
					expect(
						await frame.evaluate((element) => element.scrollWidth - element.clientWidth),
					).toBeLessThanOrEqual(1);
				}
				for (const label of fr
					? ['Attente excédentaire', 'Intervalles prolongés', 'Véhicules trop rapprochés']
					: ['Excess wait time', 'Long gaps', 'Bunching']) {
					await expect(waitingLine.getByText(label, { exact: true })).toBeVisible();
				}
			}
			await expect(bands.locator('footer')).toContainText(
				fr
					? /8\s285 passages aux arrêts, 230 trajets observés, 7 jours/
					: '8,285 stop events, 230 observed trips, 7 days',
			);
			await expect(waiting.locator('footer').locator('span')).toHaveText([
				fr ? '27 intervalles observés, 7 jours' : '27 observed intervals, 7 days',
			]);
			await expect(main.locator('#daily footer span').first()).toHaveText(
				fr ? '614 passages aux arrêts, 7 jours' : '614 stop events, 7 days',
			);
			// The notices card counts its notices in the card; a foot holding only the days says nothing.
			await expect(main.locator('#alerts footer span')).toHaveCount(0);
			await expect(waitingLine).toContainText(
				fr ? 'Mesuré sur 20 des 48 intervalles prévus' : 'Measured on 20 of the 48 gaps planned',
			);
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
			const citation = page.getByRole('dialog', {
				name: fr ? 'Citer ce bilan' : 'Cite this record',
				exact: true,
			});
			await expect(citation.getByText(/v3.*#punctuality/)).toBeVisible();
			await expect(citation.getByText(/#accessibility/)).toBeVisible();
			await citation
				.locator('[data-slot="sheet-footer"]')
				.getByRole('button', { name: fr ? 'Fermer' : 'Close', exact: true })
				.click();

			await answer
				.getByRole('button', { name: fr ? 'Télécharger' : 'Download', exact: true })
				.click();
			const sheet = page.getByRole('dialog', {
				name: fr ? 'Télécharger les fichiers CSV' : 'Download the CSV files',
				exact: true,
			});
			await expect(sheet.getByRole('link')).toHaveCount(8);
			const accessCsv = await sheet
				.getByRole('link', {
					name: fr ? 'Embarquement en fauteuil roulant' : 'Wheelchair boarding',
				})
				.getAttribute('href');
			const download = await request.get(accessCsv!);
			expect(download.headers()['content-disposition']).toContain('stop-accessibility.csv');
			expect(csvText(await download.body())).toContain(`accessible_stops,${fr ? 0 : 1}`);
			const hourlyCsv = await sheet
				.getByRole('link', { name: fr ? 'Par heure' : 'By hour' })
				.getAttribute('href');
			// French runs on OC Transpo, English on STM; each row names its source.
			expect(csvText(await (await request.get(hourlyCsv!)).body())).toBe(
				fr
					? 'Mesure,Valeur,Source des données et licence\non_time,0.8,"Données ouvertes d’OC Transpo, calculs de Transit"\n'
					: 'Measure,Value,Data source and licence\non_time,0.8,"STM open data, computed by Transit"\n',
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
	await expect(page.locator('[data-slot="screen-answer"]')).toContainText('80.0%');
	await expect(page.locator('main [data-slot="record-card"]')).toHaveCount(9);
	const delivery = page.locator('#delivery');
	await expect(delivery.locator('[data-waiting-shape="trip-facts"]')).toBeVisible();
	const deliveryHeight = (await delivery.boundingBox())?.height;
	await expect(page.locator('#byLine [data-waiting-shape="rows"]')).toBeVisible();
	await expect(page.locator('#hourly [data-waiting-shape="grid"]')).toBeVisible();
	const pendingHeight = (await page.locator('#hourly [data-slot="card"]').boundingBox())?.height;
	// The held card waits in place, pulsing, and says it is still calculating after 3 s.
	await expect(page.locator('#hourly [data-record-pending][aria-busy="true"]')).toHaveCount(1);
	await expect(page.locator('#hourly')).toContainText('Still calculating…');
	await expect(page.locator('[data-slot="record-patience"]')).toContainText(
		'Still calculating the record',
	);
	const dataPort = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';
	for (const fixture of ['stop-by-line', 'stop-hour-grid', 'stop-delivery']) {
		expect(
			(
				await request.post(`http://127.0.0.1:${dataPort}/__overview/release?fixture=${fixture}`)
			).status(),
		).toBe(204);
	}
	await expect(page.locator('#byLine')).toContainText('Too few to judge');
	await expect(page.locator('#hourly [data-slot="hour-grid"]')).toBeVisible();
	await expect(delivery).toContainText('96.0%');
	expect((await delivery.boundingBox())?.height).toBe(deliveryHeight);
	expect((await page.locator('#hourly [data-slot="card"]').boundingBox())?.height).toBe(
		pendingHeight,
	);
});

test('Stop delivery distinguishes a measured stop from a stop with too few known trips', async ({
	page,
}) => {
	const range = '?provider=stm&recordFrom=2026-11-08&recordTo=2026-11-14';
	await page.goto('/stop/57430' + range);
	const delivery = page.locator('#delivery');
	await expect(delivery).toContainText('98.0%');
	await expect(delivery).toContainText('49 of the 50 trips with a known status');
	await page.goto('/stop/archived-stop' + range);
	await expect(delivery).toContainText('Too few to judge');
	await expect(delivery.locator('dl')).toHaveCount(0);
});

test('changing the Stop record period keeps the reading position', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/stop/S1?provider=stm&recordFrom=2026-11-08&recordTo=2026-11-14');
	await expect(page.locator('#daily [data-slot="chart-line-series"]').first()).toBeVisible();
	await page.evaluate(() => window.scrollTo(0, 1000));
	await page.getByRole('radio', { name: '28 days', exact: true }).evaluate((radio) => {
		// Activate the rail control without moving the viewport to its hit target first.
		(radio as HTMLElement).click();
	});
	await expect(page).toHaveURL(/(?:\?|&)period=28-days(?:&|$)/u);
	await expect(page.locator('main [data-record-pending]')).toHaveCount(0);
	expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(1000);
});
