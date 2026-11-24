import { expect, test } from '@playwright/test';
import { dailyMessageHold } from './daily-message-hold';

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
			const late = page.getByRole('region', {
				name: fr ? 'Départs le plus souvent en retard' : 'Departures late most often',
			});
			const departure = late.getByRole('link', { name: '07:00' });
			await expect(departure).toBeVisible();
			await expect(late).toContainText(
				fr ? '5 dates de service observées' : '5 observed service dates',
			);
			await departure.click();
			await expect(page).toHaveURL(/\/departure\//);
			const main = page.getByRole('main');
			await expect(main.getByRole('heading', { level: 1 })).toContainText('07:00');
			await expect(main).toContainText(fr ? '1 des 5 jours observés' : '1 of 5 observed days');
			await expect(main).toContainText(fr ? '6 min de retard' : '6 min late');
			await expect(
				main
					.getByRole('region', {
						name: fr ? 'Départs annulés et manquants' : 'Cancelled and missing departures',
					})
					.getByRole('rowheader'),
			).toHaveCount(2);
			const stops = main.getByRole('region', { name: fr ? 'Arrêt par arrêt' : 'Stop by stop' });
			await expect(stops).toContainText(fr ? '5,3 min de retard' : '5.3 min late');
			await expect(
				stops.getByRole('button', { name: fr ? 'Copier le lien' : 'Copy link' }),
			).toBeVisible();
			await stops.getByText(fr ? 'Citer' : 'Cite', { exact: true }).click();
			await expect(stops.getByText(/v1.*day=2026-11-20.*#stops/)).toBeVisible();
			await stops.getByLabel(fr ? 'Date de service' : 'Service date').fill('2026-11-18');
			await stops
				.getByRole('button', { name: fr ? 'Afficher cette journée' : 'Show this day' })
				.click();
			await expect(stops).toContainText(fr ? '1 min d’avance' : '1 min early');
			const csv = await stops.getByRole('link', { name: /CSV/ }).getAttribute('href');
			const csvResponse = await request.get(csv!);
			expect(csvResponse.ok()).toBeTruthy();
			const csvText = await csvResponse.text();
			expect(csvText).toContain(fr ? 'Retard observé (s)' : 'Observed delay (s)');
			expect(csvText).toContain('2026-11-18,2026-11-18,-61');
			await expect(main).not.toContainText(
				/\b(?:\d+ s (?:late|early)|seconds?|secondes?)\b|\b\d{2}:\d{2}:\d{2} ·|\bDirection [01]\b/i,
			);
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
			const section = (name: string) => main.getByRole('region', { name });
			const headline = section(fr ? 'Part des passages à l’heure' : 'On-time share');
			await expect(headline).toContainText(fr ? '80 sur 100' : '80 of 100');
			await expect(headline).toContainText(fr ? 'Faible couverture' : 'Low coverage');
			const delivery = section(
				fr
					? 'Service effectué par rapport au service prévu'
					: 'Service delivered against scheduled',
			);
			await expect(delivery).toContainText('70');
			const periods = section(fr ? 'La journée en cinq périodes' : 'The day in five periods');
			await expect(periods.getByRole('rowheader')).toHaveCount(5);
			await expect(periods).toContainText(fr ? 'couverture insuffisante' : 'insufficient coverage');
			await expect(
				section(fr ? 'Lignes à examiner' : 'Lines to inspect').getByRole('link', { name: /24/ }),
			).toBeVisible();
			const messages = section(fr ? 'Avis de l’agence' : 'Agency messages');
			await expect(messages).toContainText(fr ? 'Détour sur la ligne 24' : 'Detour on 24');
			const csv = await messages.getByRole('link', { name: /CSV/ }).getAttribute('href');
			const csvResponse = await request.get(csv!);
			expect(csvResponse.ok()).toBeTruthy();
			expect(await csvResponse.text()).toMatch(fr ? /^Mesure,Du,Au/ : /^Measure,From,To/);
			expect(await main.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(width);

			await page.emulateMedia({ media: 'print' });
			await expect(
				main.getByRole('button', { name: fr ? 'Imprimer le rapport' : 'Print report' }),
			).toBeHidden();
			await expect(headline.getByText(/v1.*#punctuality/).last()).toBeVisible();
			await expect(headline.getByText(fr ? /80 sur 100/ : /80 of 100/).first()).toBeVisible();
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
	const messages = page.getByRole('region', { name: 'Agency messages' });
	const pending = 'Still working on this. You can wait or come back later.';
	try {
		expect((await hold.start()).status()).toBe(204);
		await page.setExtraHTTPHeaders(hold.headers);
		await page.goto(href, { waitUntil: 'commit' });
		await expect(page.getByRole('region', { name: 'On-time share' })).toContainText('80 of 100');

		expect((await other.release()).status()).toBe(204);
		await expect(messages).toContainText(pending);
		await test.step('another scope gets the same dates while messages are held', async () => {
			const otherReport = await request.get(href, { headers: other.headers });
			expect(otherReport.ok()).toBe(true);
			expect(await otherReport.text()).toContain('Detour on 24');
			await expect(messages).toContainText(pending);
		});

		expect((await hold.release()).status()).toBe(204);
		await expect(messages).toContainText('Not tracked');
	} finally {
		await hold.release();
	}
});

test('Departure opens the current prediction report for an exact trip identity', async ({
	page,
}) => {
	await page.goto(`/departure/${key('80')}?provider=stm&frameMode=live`);
	await expect(page.getByRole('heading', { name: /prediction report/i })).toBeVisible();
	await page.goto(`/departure/${key('24')}?provider=stm&frameMode=live`);
	await expect(page.getByText('No live data for this departure today.')).toBeVisible();
});

test('a ranked departure links to its exact line, direction, time and range', async ({ page }) => {
	await page.goto('/fr/repeat-offenders?provider=stm&recordFrom=2026-11-08&recordTo=2026-11-14');
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
