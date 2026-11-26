import { expect, test } from '@playwright/test';
import { PUBLISHED_LOCALES } from '../src/lib/i18n/config';
import { localizeHref } from '../src/lib/i18n/routing';
import { captureTrip, captureTripReport, captureUrl, installStopCapture } from './capture-fixture';
import { openFrameControls } from './frame-controls';

const at = Date.parse('2026-11-25T13:12:00Z');
const dates = 'recordFrom=2026-11-08&recordTo=2026-11-14';
const provider = 'stm';

test.use({ bypassCSP: true });
test.beforeEach(async ({ page }) => {
	await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
});

for (const locale of PUBLISHED_LOCALES) {
	const fr = locale === 'fr';
	const path = (id: string, query: string) =>
		localizeHref(`/stop/${id}?${query}&${dates}`, locale, provider);

	test(`${locale}: live predicts fifteen minutes ahead in one linked table and preserves the Record header`, async ({
		page,
	}) => {
		const oldRequests: string[] = [];
		page.on('request', (request) => {
			if (new URL(request.url()).pathname.startsWith('/v1/')) oldRequests.push(request.url());
		});
		const refresh = await installStopCapture(page, provider, 'S1', at);
		await page.goto(path('S1', 'tab=detail'));
		await refresh();
		const content = page.locator('[data-slot="screen-content"]');
		const answer = page.locator('[data-slot="screen-answer"]');
		await expect(answer).toContainText(
			fr ? '2 véhicules sont attendus' : '2 vehicles are expected',
		);
		const table = content.getByRole('table');
		await expect(table).toHaveCount(1);
		await expect(table.locator('tbody tr')).toHaveCount(6);
		const calls = table.locator('tbody tr');
		const headers = fr
			? ['Ligne', 'Vers', 'Horaire', 'Prévu', 'État']
			: ['Line', 'Toward', 'Scheduled', 'Expected', 'Status'];
		await expect(table.getByRole('columnheader')).toHaveText(headers);
		await expect(
			calls.nth(0).getByRole('rowheader').locator('.data-table-cell-content'),
		).not.toContainText('Gare Montréal-Ouest');
		await expect(
			calls.nth(0).locator('[data-column="toward"] .data-table-cell-content'),
		).toHaveText('Gare Montréal-Ouest');
		await expect(
			calls.nth(0).locator('[data-column="scheduled"] .data-table-cell-content'),
		).toHaveText('08:15');
		for (const index of [1, 2]) {
			for (const column of ['scheduled', 'toward']) {
				await expect(
					calls.nth(index).locator(`[data-column="${column}"] .data-table-cell-content`),
				).toHaveText(fr ? 'Indisponible' : 'Unavailable');
			}
		}
		const phone = (page.viewportSize()?.width ?? 1440) <= 448;
		if (phone) {
			const labels = calls.nth(0).locator('.data-table-stack-label');
			await expect(labels).toHaveCount(5);
			for (let i = 0; i < 5; i++) await expect(labels.nth(i)).toBeVisible();
		} else {
			await expect(calls.nth(0).locator('.data-table-stack-label').first()).toBeHidden();
		}
		expect(await table.innerText()).not.toMatch(
			/Scheduled Unavailable|Horaire Indisponible|Toward Unavailable|Vers Indisponible/,
		);
		await expect(calls.nth(0).getByRole('rowheader').getByRole('link')).toHaveAttribute(
			'href',
			/\/lines\/24\?/,
		);
		await expect(
			calls.nth(0).locator('[data-column="expected"]').getByRole('link'),
		).toHaveAttribute('href', /\/departure\//);
		await expect(
			content.getByRole('heading', { name: fr ? 'Avis pour cet arrêt' : 'Notices for this stop' }),
		).toBeVisible();
		const header = page.locator('header').filter({ has: page.locator('#stop-title') });
		const originalTitle = await header.innerText();
		expect(new URL(page.url()).searchParams.has('tab')).toBe(false);
		await expect(page.locator('[data-page-section-edges]').filter({ has: header })).toHaveCount(1);
		const before = (await header.boundingBox())?.height;
		const controls = await openFrameControls(page, locale);
		await controls.getByRole('radio', { name: fr ? 'Bilan' : 'Record', exact: true }).click();
		await expect(page).toHaveURL((url) => url.searchParams.get('frameMode') === 'record');
		await expect(header).toHaveText(originalTitle);
		expect((await header.boundingBox())?.height).toBe(before);
		expect(oldRequests).toEqual([]);
	});

	test(`${locale}: with no vehicle in 15 minutes the answer is the next vehicle, never a zero`, async ({
		page,
	}) => {
		const refresh = await installStopCapture(page, provider, 'S1', at);
		await page.route('**/api/live-trips?city=stm&stop=S1', async (route) => {
			const now = await page.evaluate(() => Date.now());
			await route.fulfill({
				json: captureTripReport(provider, new Date(now).toISOString(), [
					{
						...captureTrip('late-trip', '24', [
							{
								stop: 'S1',
								eta_utc: new Date(now + 20 * 60_000).toISOString(),
								delay_min: 4,
								scheduled_utc: new Date(now + 16 * 60_000).toISOString(),
							},
						]),
						trip_headsign: 'Nord',
					},
				]),
			});
		});
		await page.goto(path('S1', 'frameMode=live'));
		await refresh();
		const answer = page.locator('[data-slot="screen-answer"]');
		await expect(answer).toContainText(fr ? 'dans 20 min' : 'in 20 min');
		await expect(answer).toContainText(
			fr
				? /Aucun véhicule dans les 15 prochaines minutes\. Prochain\u00a0: ligne \S+ vers .+, prévu à .+\./u
				: /No vehicle in the next 15 minutes\. Next: line \S+ toward .+, scheduled .+\./u,
		);
		await expect(answer).not.toContainText(fr ? 'pourcentage' : 'percentage');
		// The rider's direction, as on the line pages: never the bare compass word.
		await expect(answer).not.toContainText(fr ? 'vers Nord' : 'toward Nord');
		const predictions = page.locator('[data-slot="stop-live-predictions"]');
		await expect(predictions.locator('tbody [data-column="status"]').first()).toContainText(
			fr ? /À l’heure\s*\(4 min de retard\)/u : /On time\s*\(4 min behind\)/u,
		);
		// The "Delay unknown" helper shows only when a row has that state.
		await expect(predictions).not.toContainText(fr ? 'Retard inconnu' : 'Delay unknown');
	});

	test(`${locale}: live updates pause from the keyboard, are announced and hold across Live screens`, async ({
		page,
	}) => {
		const refresh = await installStopCapture(page, provider, 'S1', at);
		await page.goto(path('S1', 'frameMode=live'));
		await refresh();
		const name = fr ? 'Suspendre les mises à jour' : 'Pause live updates';
		const rail = await openFrameControls(page, locale);
		const toggle = rail.getByRole('switch', { name });
		await expect(toggle).toHaveAttribute('aria-checked', 'false');
		await toggle.focus();
		await page.keyboard.press('Space');
		await expect(toggle).toHaveAttribute('aria-checked', 'true');
		await expect(toggle).toBeFocused();
		await expect(rail.locator('[data-slot="live-pause-status"]')).toHaveText(
			fr ? 'Mises à jour en direct suspendues.' : 'Live updates paused.',
		);
		await expect(
			page.locator('[data-slot="screen-answer"] [data-slot="stamp"]').first(),
		).toContainText(fr ? 'En pause · mis à jour' : 'Paused · updated');
		let captures = 0;
		page.on('request', (request) => {
			if (captureUrl.test(request.url())) captures += 1;
		});
		await page.clock.fastForward(61_000);
		expect(captures).toBe(0);

		// The choice holds while the visitor moves to another Live screen in the same tab.
		await page.goto(localizeHref('/network?frameMode=live', locale, provider));
		await expect(page.locator('html[data-hydrated]')).toHaveCount(1);
		const rail2 = page.locator('.app-frame-controls-rail');
		if (!(await rail2.isVisible())) {
			// By keyboard: the Controls pill may sit under the footer on a short page.
			await page
				.getByRole('button', {
					name: fr ? /^Commandes.*Ouvrir les commandes/ : /^Controls.*Open controls/,
				})
				.focus();
			await page.keyboard.press('Enter');
		}
		const next = rail2.getByRole('switch', { name });
		await expect(next).toHaveAttribute('aria-checked', 'true');
		const resumed = page.waitForResponse((response) => captureUrl.test(response.url()));
		await next.focus();
		await page.keyboard.press('Enter');
		await expect(next).toHaveAttribute('aria-checked', 'false');
		await expect(page.locator('[data-slot="live-pause-status"]')).toHaveText(
			fr ? 'Mises à jour en direct reprises.' : 'Live updates resumed.',
		);
		await resumed;
	});

	test(`${locale}: live pages results after 20 with no line-group headings`, async ({ page }) => {
		const refresh = await installStopCapture(page, provider, 'S1', at);
		await page.route('**/api/live-trips?city=stm&stop=S1', async (route) => {
			const now = await page.evaluate(() => Date.now());
			await route.fulfill({
				json: captureTripReport(
					provider,
					new Date(now).toISOString(),
					Array.from({ length: 21 }, (_, index) =>
						captureTrip(`trip-${index}`, index % 2 ? '80' : '24', [
							{
								stop: 'S1',
								eta_utc: new Date(now + (index + 1) * 60_000).toISOString(),
								delay_min: null,
							},
						]),
					),
				),
			});
		});
		await page.goto(path('S1', 'frameMode=live'));
		await refresh();
		const table = page.locator('[data-slot="stop-live-predictions"]').getByRole('table');
		await expect(table.locator('tbody tr')).toHaveCount(20);
		await expect(table).toContainText(fr ? 'Retard inconnu' : 'Delay unknown');
		await page.getByRole('button', { name: fr ? 'Afficher 1 de plus' : 'Show 1 more' }).click();
		await expect(table.locator('tbody tr')).toHaveCount(21);
		await expect(page.locator('[data-slot="stop-live-predictions"] h3')).toHaveCount(0);
	});

	test(`${locale}: a stop outside the timetable links to its historical Record without an error page`, async ({
		page,
	}) => {
		const notice = fr
			? 'Cet arrêt ne figure pas à l’horaire actuel.'
			: 'This stop is not in the current timetable.';
		const live = await page.goto(path('archived-stop', 'frameMode=live'));
		expect(live?.status()).toBe(200);
		const answer = page.locator('[data-slot="screen-answer"]');
		await expect(answer.getByText(notice, { exact: true })).toBeVisible();
		await answer.getByRole('link', { name: fr ? 'Voir le bilan' : 'View record' }).click();
		await expect(page).toHaveURL(
			(url) => url.searchParams.get('frameMode') === 'record' && url.search.includes(dates),
		);
		await expect(answer).toContainText(fr ? /80,0\s%/u : '80.0%');
		// An id the record never held is not a page of empty cards.
		const missing = await page.goto(path('57135', 'frameMode=record'));
		expect(missing?.status()).toBe(404);
		await expect(
			page.getByRole('heading', {
				level: 1,
				name: fr ? 'Cet arrêt est introuvable' : 'This stop could not be found',
			}),
		).toBeVisible();
		await expect(page.getByTestId('construction-scene')).toHaveCount(0);
		await expect(
			page.getByRole('link', { name: fr ? 'Trouver un arrêt' : 'Find a stop' }),
		).toBeVisible();
		await expect(page.getByRole('main').locator('[data-slot="record-card"]')).toHaveCount(0);
	});
}

test('stale and empty trip captures have different states', async ({ page }) => {
	let stale = true;
	const refresh = await installStopCapture(page, provider, 'S1', at);
	await page.route('**/api/live-trips?city=stm&stop=S1', async (route) => {
		const now = await page.evaluate(() => Date.now());
		await route.fulfill({
			json: captureTripReport(provider, new Date(now - (stale ? 300_000 : 0)).toISOString(), []),
		});
	});
	await page.goto(localizeHref('/stop/S1?frameMode=live', 'en', provider));
	await refresh();
	const answer = page.locator('[data-slot="screen-answer"]');
	await expect(answer).toContainText('out of date');
	stale = false;
	await refresh();
	await expect(answer).toContainText('No vehicle is predicted now.');
	await expect(page.locator('[data-slot="stop-live-predictions"]')).toHaveCount(0);
});

test('Record shows the low coverage explanation once', async ({ page }) => {
	await page.goto('/stop/S1?provider=stm&recordFrom=2026-10-24&recordTo=2026-10-24');
	// One sentence, with the sample it was judged on.
	await expect(
		page.getByText(/^5 of 100 scheduled stop events were observed here on these dates\./u),
	).toHaveCount(1);
	await expect(page.getByRole('main')).not.toContainText('Not measured (insufficient coverage)');
	await expect(page.getByRole('main')).not.toContainText('Low coverage');
});
