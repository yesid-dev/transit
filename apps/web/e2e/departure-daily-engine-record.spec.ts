import { expect, test } from '@playwright/test';
import { dailyMessageHold } from './daily-message-hold';
import { captureTrip, captureTripReport } from './capture-fixture';

test.use({ bypassCSP: true });
test.beforeEach(({ browserName }, info) => {
	test.skip(browserName !== 'chromium' || info.project.name !== 'desktop');
});

const period = 'provider=stm&frameMode=record&recordFrom=2026-11-18&recordTo=2026-11-20';
// A departure must have observations on at least five service dates to appear in a ranking.
const departurePeriod = period.replace('recordFrom=2026-11-18', 'recordFrom=2026-11-16');
const key = (line: string) => encodeURIComponent(JSON.stringify([line, 0, '07:00:00']));
for (const width of [390, 1440]) {
	for (const lang of ['en', 'fr'] as const) {
		const fr = lang === 'fr';
		const path = fr ? '/fr' : '';
		const downloadTitle = fr ? 'Télécharger les fichiers CSV' : 'Download the CSV files';
		const close = { name: fr ? 'Fermer' : 'Close', exact: true };
		test(`${lang} at ${width}px shows a scheduled departure and changes the stop date`, async ({
			page,
			request,
		}) => {
			await page.setViewportSize({ width, height: 900 });
			await page.goto(`${path}/lines/24?${departurePeriod}`);
			await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
			const late = page.getByRole('article', {
				name: fr ? 'Départs le plus souvent en retard' : 'Departures late most often',
			});
			if (width === 390) await late.getByRole('button').first().click();
			const departure = late.getByRole('link', { name: fr ? /^7\sh\b/u : /^07:00\b/u });
			await expect(departure).toBeVisible();
			await expect(late).toContainText(
				fr ? '5 dates de service observées' : '5 observed service dates',
			);
			await departure.click();
			await expect(page).toHaveURL(/\/departure\//);
			const main = page.getByRole('main');
			await expect(main.getByRole('heading', { level: 1 })).toContainText(fr ? '7 h' : '07:00');
			// The answer is the late share of stop events; the days count is its detail.
			await expect(main.locator('[data-slot="screen-answer"]')).toContainText(
				fr ? /1,0\s%/u : '1.0%',
			);
			await expect(main).toContainText(fr ? '1 des 5 jours' : '1 of the 5 days');
			await expect(main).toContainText(fr ? '6 min de retard' : '6 min late');
			await expect(
				main
					.getByRole('article', {
						name: fr ? 'Départs annulés et manquants' : 'Cancelled and missing departures',
					})
					.getByRole('rowheader'),
			).toHaveCount(2);
			const stops = main.getByRole('article', { name: fr ? 'Arrêt par arrêt' : 'Stop by stop' });
			await expect(stops).toContainText(fr ? '5,3 min de retard' : '5.3 min late');
			const relatedStop = stops.getByRole('link', { name: fr ? /^Voir l’arrêt /u : /^See stop /u });
			await expect(relatedStop).toHaveAttribute('href', /\/stop\/[^?]+\?.*provider=stm/u);
			const tripsOnDay = stops.getByRole('link', {
				name: fr ? 'Trajets effectués ici à cette date' : 'Trips that ran here on this date',
			});
			await expect(tripsOnDay).toHaveAttribute(
				'href',
				/\/stop\/[^?]+\?.*recordFrom=2026-11-20&recordTo=2026-11-20#delivery$/u,
			);
			await main.getByRole('button', { name: fr ? 'Citer' : 'Cite', exact: true }).click();
			const citation = page.getByRole('dialog', {
				name: fr ? 'Citer ce bilan' : 'Cite this record',
				exact: true,
			});
			await expect(citation).toContainText(/v1[\s\S]*day=2026-11-20[^ ]*#stops/);
			await citation.locator('[data-slot="sheet-footer"]').getByRole('button', close).click();
			await expect(main.locator('input[type=date]')).toHaveCount(0);
			await stops.getByRole('link', { name: fr ? '18 novembre 2026' : '18 November 2026' }).click();
			await expect(stops).toContainText(fr ? '1 min d’avance' : '1 min early');
			await main
				.getByRole('button', { name: fr ? 'Télécharger' : 'Download', exact: true })
				.click();
			const downloads = page.getByRole('dialog', { name: downloadTitle, exact: true });
			const csv = await downloads
				.getByRole('link', { name: fr ? 'Arrêt par arrêt' : 'Stop by stop' })
				.getAttribute('href');
			const csvResponse = await request.get(csv!);
			expect(csvResponse.ok()).toBeTruthy();
			const csvText = await csvResponse.text();
			expect(csvText).toContain(fr ? 'Retard observé (s)' : 'Observed delay (s)');
			expect(csvText).toContain('2026-11-18,2026-11-18,-61');
			await expect(main).not.toContainText(
				/\b(?:\d+ s (?:late|early)|seconds|secondes|\d+\s+(?:second|seconde))\b|\b\d{2}:\d{2}:\d{2} ·|\bDirection [01]\b/i,
			);
			await downloads.locator('[data-slot="sheet-footer"]').getByRole('button', close).click();
			await stops.getByRole('link', { name: fr ? '19 novembre 2026' : '19 November 2026' }).click();
			await expect(
				stops.getByRole('list', { name: fr ? 'Arrêt par arrêt' : 'Stop by stop' }),
			).toContainText(fr ? 'Non mesuré' : 'Not measured');
			await expect(stops).not.toContainText(/0%|0 min/);
			expect(await main.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(width);
			if (width === 1440) {
				await tripsOnDay.click();
				await expect(page).toHaveURL(/recordFrom=2026-11-19&recordTo=2026-11-19#delivery$/u);
				await expect(
					page.locator('#delivery').getByRole('heading', {
						name: fr ? 'Trajets effectués à cet arrêt' : 'Trips that ran at this stop',
					}),
				).toBeVisible();
			}
		});

		test(`${lang} at ${width}px shows the Daily report and preserves evidence in print`, async ({
			page,
			request,
		}) => {
			await page.setViewportSize({ width, height: 900 });
			const response = await page.goto(`${path}/receipt?${period}`, { waitUntil: 'commit' });
			expect(response?.headers()['cache-control']).toBe('no-store, no-transform');
			const main = page.getByRole('main');
			const section = (name: string) => main.getByRole('article', { name, exact: true });
			const headline = main.locator('#punctuality');
			await expect(headline).toContainText(fr ? /80,0\s%/u : '80.0%');
			await expect(headline).toContainText(fr ? /92,3\s%/u : '92.3%');
			const delivery = section(
				fr
					? 'Service effectué par rapport au service prévu'
					: 'Service delivered against scheduled',
			);
			await expect(delivery).toContainText('70');
			const periods = section(fr ? 'La journée en cinq périodes' : 'The day in five parts');
			await expect(periods.getByRole('rowheader')).toHaveCount(5);
			await expect(periods).toContainText(fr ? 'Trop peu observé' : 'Too little observed');
			const messages = section(fr ? 'Avis de la société de transport' : 'Agency notices');
			await expect(messages.getByRole('heading', { level: 3 })).toHaveCount(1);
			await expect(messages.getByRole('heading', { level: 3 })).toHaveAttribute('lang', lang);
			await expect(messages).toContainText(fr ? 'Détour sur la ligne 24' : 'Detour on 24');
			await expect(
				messages.getByRole('link', {
					name: fr ? 'Voir 1 avis dans les avis de service' : 'See 1 notice in Service alerts',
				}),
			).toHaveAttribute('href', /\/alerts\?.*recordFrom=2026-11-18/);
			await main
				.getByRole('button', { name: fr ? 'Télécharger' : 'Download', exact: true })
				.click();
			const downloads = page.getByRole('dialog', { name: downloadTitle, exact: true });
			const csv = await downloads
				.getByRole('link', {
					name: fr ? 'Avis de la société de transport' : 'Agency notices',
					exact: true,
				})
				.getAttribute('href');
			const csvResponse = await request.get(csv!);
			expect(csvResponse.ok()).toBeTruthy();
			expect(await csvResponse.text()).toMatch(fr ? /^Mesure,Du,Au/ : /^Measure,From,To/);
			await downloads.locator('[data-slot="sheet-footer"]').getByRole('button', close).click();
			expect(await main.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(width);

			await page.emulateMedia({ media: 'print' });
			await expect(
				main.getByRole('button', { name: fr ? 'Imprimer' : 'Print', exact: true }),
			).toBeHidden();
			await expect(main.getByText(/v1.*#punctuality/).last()).toBeVisible();
			await expect(delivery.getByText('70', { exact: true })).toBeVisible();
		});
	}
}

test('Daily report streams past a slow agency section and distinguishes untracked messages', async ({
	page,
	request,
}) => {
	const href = '/receipt?provider=stm&frameMode=record&recordFrom=2026-11-17&recordTo=2026-11-17';
	const hold = dailyMessageHold(request);
	const other = dailyMessageHold(request);
	const messages = page.getByRole('article', { name: 'Agency notices' });
	const pending = 'Still calculating the record';
	try {
		expect((await hold.start()).status()).toBe(204);
		await page.setExtraHTTPHeaders(hold.headers);
		await page.goto(href, { waitUntil: 'commit' });
		await expect(page.getByRole('region', { name: 'On-time share' })).toContainText('80.0%');

		expect((await other.release()).status()).toBe(204);
		await expect(page.locator('[data-slot="record-patience"]')).toContainText(pending);
		await test.step('another scope gets the same dates while messages are held', async () => {
			const otherReport = await request.get(href, { headers: other.headers });
			expect(otherReport.ok()).toBe(true);
			expect(await otherReport.text()).toContain('Detour on 24');
			await expect(page.locator('[data-slot="record-patience"]')).toContainText(pending);
		});

		expect((await hold.release()).status()).toBe(204);
		await expect(messages).toContainText(
			'Not tracked: Transit did not collect STM’s notices on these dates.',
		);
	} finally {
		await hold.release();
	}
});

test('Departure opens the current prediction report for an exact trip identity', async ({
	page,
}) => {
	const timestamp = '2026-11-23T16:00:00.000Z';
	await page.clock.setFixedTime(Date.parse(timestamp) + 30_000);
	await page.route('**/api/live-trips?city=stm&trip=T1', (route) =>
		route.fulfill({
			json: captureTripReport('stm', timestamp, [
				captureTrip('T1', '80', [{ stop: 'S1', eta_utc: '2026-11-23T16:10:00.000Z' }]),
			]),
		}),
	);
	await page.goto(`/departure/${key('80')}?provider=stm&frameMode=live`);
	const report = page.getByRole('article', { name: 'Reported predictions' });
	await expect(report.getByRole('table')).toContainText('11:10');
	await expect(report.getByText('These are predictions, not observed arrivals.')).toBeVisible();
	await expect(
		report.getByRole('link', { name: 'Download all predictions (CSV)' }),
	).toHaveAttribute('download', 'trip-T1-all-predictions.csv');
	await page.goto(`/departure/${key('24')}?provider=stm&frameMode=live`);
	await expect(page.getByText('No live data for this departure today.')).toBeVisible();
	await expect(page.getByRole('link', { name: 'See this departure’s Record' })).toHaveAttribute(
		'href',
		/\/departure\/[^?]+\?.*frameMode=record/u,
	);
});

for (const locale of ['en', 'fr'] as const) {
	test(`${locale} Live departure explains a future scheduled start`, async ({ page }) => {
		const fr = locale === 'fr';
		const path = fr ? '/fr' : '';
		const nextDay = encodeURIComponent(JSON.stringify(['24', 0, '25:10:00']));
		await page.goto(`${path}/departure/${nextDay}?provider=stm&frameMode=live`);
		await expect(page.getByRole('main')).toContainText(fr ? 'Départ prévu' : 'Scheduled departure');
		await expect(page.getByRole('main')).toContainText(
			fr
				? 'Les données en direct s’affichent dès que son véhicule commence à transmettre.'
				: 'Live data appears once its vehicle starts reporting.',
		);
	});
}

test('a ranked departure links to its exact line, direction, time and range', async ({ page }) => {
	await page.goto(
		'/fr/rankings?kind=departure&provider=stm&recordFrom=2026-11-08&recordTo=2026-11-14',
	);
	const ranking = page.getByRole('table', { name: 'Départs', exact: true });
	const link = ranking.getByRole('link', { name: /7\sh\s15 vers West B9/u });
	await expect(link).toBeVisible();
	await expect(ranking.getByRole('img', { name: /38,0\s*% à 58,0\s*%/u })).toBeVisible();
	const target = new URL((await link.getAttribute('href'))!, page.url());
	expect(decodeURIComponent(target.pathname)).toBe('/fr/departure/["24",0,"07:15:00"]');
	expect(target.searchParams.get('provider')).toBe('stm');
	expect(target.searchParams.get('frameMode')).toBe('record');
	expect(target.searchParams.get('recordFrom')).toBe('2026-11-08');
	expect(target.searchParams.get('recordTo')).toBe('2026-11-14');
});

test('a departure on an unknown line has a single timetable state', async ({ page }) => {
	await page.goto(`/departure/${key('not-published')}?${departurePeriod}`);
	const main = page.getByRole('main');
	await expect(main.locator('[data-slot="screen-answer"]')).toContainText(
		'This line is not in the current timetable.',
	);
	await expect(main.locator('[data-slot="record-card"]')).toHaveCount(0);
});

for (const locale of ['en', 'fr'] as const) {
	test(`${locale} Departure busy answer shows the shared pending line`, async ({ page }) => {
		const fr = locale === 'fr';
		await page.goto(
			`${fr ? '/fr' : ''}/departure/${key('24')}?provider=stm&frameMode=record&recordFrom=2026-11-22&recordTo=2026-11-22`,
		);
		await expect(
			page.locator('[data-slot="screen-answer"] [data-slot="record-pending-words"]'),
		).toHaveText(
			fr
				? 'En attente. Cette carte redemande dans quelques secondes.'
				: 'Waiting for a turn. This card asks again in a few seconds.',
		);
		await expect(page.locator('[data-slot="record-patience"]')).toHaveCount(1);
		await expect(page.locator('[data-slot="record-patience"]')).toContainText(
			fr ? 'Le calcul du bilan' : 'Still calculating the record',
		);
	});
}
