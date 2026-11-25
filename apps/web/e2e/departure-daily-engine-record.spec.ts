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
			const departure = late.getByRole('link', { name: /^07:00\b/u });
			await expect(departure).toBeVisible();
			await expect(late).toContainText(
				fr ? '5 dates de service observées' : '5 observed service dates',
			);
			await departure.click();
			await expect(page).toHaveURL(/\/departure\//);
			const main = page.getByRole('main');
			await expect(main.getByRole('heading', { level: 1 })).toContainText('07:00');
			await expect(main).toContainText(fr ? '1 sur 5' : '1 of 5');
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
			await main.getByRole('button', { name: fr ? 'Citer' : 'Cite', exact: true }).click();
			await expect(page.getByRole('dialog')).toContainText(/v1[\s\S]*day=2026-11-20[^ ]*#stops/);
			await page.getByRole('button', { name: fr ? 'Fermer' : 'Close', exact: true }).click();
			await expect(main.locator('input[type=date]')).toHaveCount(0);
			await stops.getByRole('link', { name: fr ? '18 novembre 2026' : '18 November 2026' }).click();
			await expect(stops).toContainText(fr ? '1 min d’avance' : '1 min early');
			await main
				.getByRole('button', { name: fr ? 'Télécharger' : 'Download', exact: true })
				.click();
			const csv = await page
				.getByRole('dialog')
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
			await page.getByRole('button', { name: fr ? 'Fermer' : 'Close', exact: true }).click();
			await stops.getByRole('link', { name: fr ? '19 novembre 2026' : '19 November 2026' }).click();
			await expect(
				stops.getByRole('list', { name: fr ? 'Arrêt par arrêt' : 'Stop by stop' }),
			).toContainText(fr ? 'Non mesuré' : 'Not measured');
			await expect(stops).not.toContainText(/0%|0 min/);
			expect(await main.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(width);
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
			await expect(periods).toContainText(fr ? 'Couverture insuffisante' : 'Insufficient coverage');
			const messages = section(fr ? 'Avis de l’agence' : 'Agency messages');
			await expect(messages.getByRole('heading', { level: 3 })).toHaveCount(1);
			await expect(messages.getByRole('heading', { level: 3 })).toHaveAttribute('lang', lang);
			await expect(messages).toContainText(fr ? 'Détour sur la ligne 24' : 'Detour on 24');
			await expect(
				messages.getByRole('link', {
					name: fr ? 'Voir l’avis de service' : 'See the service alert',
				}),
			).toHaveAttribute('href', /\/alerts\?.*recordFrom=2026-11-18/);
			await main
				.getByRole('button', { name: fr ? 'Télécharger' : 'Download', exact: true })
				.click();
			const csv = await page
				.getByRole('dialog')
				.getByRole('link', { name: fr ? 'Avis de l’agence' : 'Agency messages', exact: true })
				.getAttribute('href');
			const csvResponse = await request.get(csv!);
			expect(csvResponse.ok()).toBeTruthy();
			expect(await csvResponse.text()).toMatch(fr ? /^Mesure,Du,Au/ : /^Measure,From,To/);
			await page.getByRole('button', { name: fr ? 'Fermer' : 'Close', exact: true }).click();
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
	const messages = page.getByRole('article', { name: 'Agency messages' });
	const pending = 'These records take longer';
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
		await expect(messages).toContainText('Agency messages are not tracked in this city.');
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
});

test('a ranked departure links to its exact line, direction, time and range', async ({ page }) => {
	await page.goto(
		'/fr/rankings?kind=departure&provider=stm&recordFrom=2026-11-08&recordTo=2026-11-14',
	);
	const ranking = page.getByRole('region', { name: 'Départs', exact: true });
	const link = ranking.getByRole('link', { name: /07:15/ }).first();
	await expect(link).toBeVisible();
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
		await expect(page.locator('[data-slot="screen-answer"]')).toHaveText(
			fr ? 'Lecture en attente.' : 'Waiting for a reading.',
		);
		await expect(page.locator('[data-slot="record-patience"]')).toHaveCount(1);
		await expect(page.locator('[data-slot="record-patience"]')).toContainText(
			fr ? 'Ce bilan demande plus de temps' : 'These records take longer',
		);
	});
}
