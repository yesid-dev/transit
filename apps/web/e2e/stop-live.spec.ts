import { expect, test } from '@playwright/test';
import { PUBLISHED_LOCALES } from '../src/lib/i18n/config';
import { localizeHref } from '../src/lib/i18n/routing';
import { captureTrip, captureTripReport, installStopCapture } from './capture-fixture';
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
		await expect(table.getByRole('columnheader')).toHaveText(
			fr
				? ['Ligne', 'Vers', 'Horaire', 'Prévu', 'État']
				: ['Line', 'Toward', 'Scheduled', 'Expected', 'Status'],
		);
		await expect(table.getByRole('link').first()).toHaveAttribute('href', /\/lines\/24\?/);
		const calls = table.locator('tbody tr');
		await expect(calls.nth(0).locator('[data-column="toward"]')).toContainText(
			'Gare Montréal-Ouest',
		);
		await expect(calls.nth(0).locator('[data-column="scheduled"]')).toContainText('08:15');
		for (const index of [1, 2]) {
			for (const column of ['scheduled', 'toward']) {
				await expect(calls.nth(index).locator(`[data-column="${column}"]`)).toContainText(
					fr ? 'Indisponible' : 'Unavailable',
				);
			}
		}
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
		await expect(answer).toContainText(fr ? '80 %' : '80%');
		const missing = await page.goto(path('57135', 'frameMode=record'));
		expect(missing?.status()).toBe(200);
		await expect(page.getByText(notice, { exact: true })).toBeVisible();
		await expect(answer).toContainText(
			fr ? 'Aucune lecture n’a été publiée' : 'No readings were published',
		);
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
	await expect(answer).toContainText('No current prediction for this stop.');
	await expect(page.locator('[data-slot="stop-live-predictions"]')).toHaveCount(0);
});

test('Record shows the low coverage explanation once', async ({ page }) => {
	await page.goto('/stop/S1?provider=stm&recordFrom=2026-10-24&recordTo=2026-10-24');
	await expect(
		page.getByText(
			'There are too few observed stop events to measure punctuality for these dates.',
			{ exact: true },
		),
	).toHaveCount(1);
	await expect(page.getByRole('main')).not.toContainText('Not measured (insufficient coverage)');
	await expect(page.getByRole('main')).not.toContainText('Low coverage');
});
