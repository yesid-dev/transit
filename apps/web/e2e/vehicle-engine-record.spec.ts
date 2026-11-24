import { expect, test } from '@playwright/test';
import { captureFixture, captureUrl, captureVehicle } from './capture-fixture';

test.use({ bypassCSP: true });
test.beforeEach(({ browserName }, info) => {
	test.skip(browserName !== 'chromium' || info.project.name !== 'desktop');
});

const dates = 'recordFrom=2026-11-08&recordTo=2026-11-14';
for (const width of [390, 1440]) {
	for (const locale of ['en', 'fr']) {
		const fr = locale === 'fr';
		const prefix = fr ? '/fr' : '';
		const search = fr ? 'Rechercher par numéro de véhicule' : 'Find by vehicle number';
		test(`${locale} at ${width}px searches the fleet and opens a citable vehicle record`, async ({
			page,
			request,
		}) => {
			await page.setViewportSize({ width, height: 900 });
			await page.goto(`${prefix}/vehicles?provider=stm&frameMode=record&${dates}`);
			const main = page.getByRole('main');
			const table = main.getByRole('table');
			await expect(table.getByRole('rowheader')).toHaveCount(2, { timeout: 15_000 });
			await main.getByRole('searchbox', { name: search }).fill('0061');
			await expect(table.getByRole('rowheader')).toHaveCount(1);
			await expect(table.getByRole('row', { name: '40061 5' })).toBeVisible();
			await main.getByRole('link', { name: '40061' }).click();
			await expect(page).toHaveURL(/vehicle\/40061\?.*recordFrom=2026-11-08/);
			await expect(
				main.getByRole('heading', { name: fr ? 'Véhicule 40061' : 'Vehicle 40061' }),
			).toBeVisible();
			await expect(
				main.getByRole('region', {
					name: fr ? 'Jours et heures en service' : 'Days and hours in service',
				}),
			).toContainText(fr ? '12,5' : '12.5');
			await expect(
				main.getByRole('region', {
					name: fr ? 'Lignes et voyages effectués' : 'Lines and trips it ran',
				}),
			).toContainText('12');
			await expect(
				main.getByRole('region', {
					name: fr ? 'Interruptions de signalement' : 'Stopped reporting',
				}),
			).toContainText(fr ? '16 interruptions par 100 heures' : '16 interruptions per 100 hours');
			const completion = main.getByRole('region', {
				name: fr ? 'Voyages non terminés' : 'Trips it did not finish',
			});
			await expect(completion).toContainText(fr ? 'Non suivi' : 'Not tracked');
			await expect(completion).toContainText(
				fr
					? 'Les flux en direct ne montrent pas de façon fiable quand un trajet se termine tôt'
					: 'The live feeds do not show reliably when a trip ends early',
			);
			await expect(completion).not.toContainText(fr ? 'sur 20 voyages' : 'of 20 trips');
			const timing = main.getByRole('region', {
				name: fr ? 'Son bilan de ponctualité' : 'Its on-time record',
			});
			await expect(timing).toContainText(
				fr ? 'les lignes et les heures qu’on lui confie' : 'the lines and hours it is assigned to',
			);
			await expect(timing).toContainText(fr ? 'Trop peu pour juger' : 'Too few to judge');
			await expect(
				timing.getByRole('button', { name: fr ? 'Copier le lien' : 'Copy link' }),
			).toBeVisible();
			await timing.getByText(fr ? 'Citer' : 'Cite', { exact: true }).click();
			await expect(timing.getByText(/v1.*#punctuality/)).toBeVisible();
			const href = await timing.getByRole('link', { name: /CSV/ }).getAttribute('href');
			const csv = await request.get(href!);
			expect(csv.ok()).toBeTruthy();
			expect(await csv.text()).toMatch(fr ? /^Mesure,Valeur/ : /^Measure,Value/);
			expect(await main.evaluate((node) => node.scrollWidth)).toBeLessThanOrEqual(width);
		});
		test(`${locale} at ${width}px keeps the live status and handles a missing report`, async ({
			page,
		}) => {
			await page.setViewportSize({ width, height: 900 });
			const now = Date.now();
			await page.route(/\/api\/schedule-edition\?city=stm$/, async (route) => {
				const response = await route.fetch();
				const { schedule } = await response.json();
				const routes = schedule.routes.filter(({ id }: { id: string }) => id !== '80');
				routes.push({ id: '80', short: '80', type: 3 });
				await route.fulfill({
					response,
					json: {
						schedule: {
							...schedule,
							routes,
							route_directions: {
								...schedule.route_directions,
								80: [{ dir: 1, headsign: 'Parc', stops: [{ id: 'S1', seq: 1 }] }],
							},
						},
					},
				});
			});
			await page.route(captureUrl, (route) =>
				route.fulfill({
					json: captureFixture(now, {
						vehicle_positions: [captureVehicle(now, { route_id: '80' })],
					}),
				}),
			);
			await page.goto(`${prefix}/vehicles?provider=stm&frameMode=live&${dates}`);
			const main = page.getByRole('main');
			await main.getByRole('searchbox', { name: search }).fill('0061');
			await expect(main.getByRole('row', { name: /40061.*Parc/ })).toBeVisible();
			await main.getByRole('link', { name: '40061' }).click();
			await expect(
				main.getByRole('heading', {
					name: fr
						? 'À l’heure, 4 min après l’heure prévue'
						: 'On time, 4 min behind the timetable',
				}),
			).toBeVisible();
			await expect(main.getByRole('link', { name: /T1/ })).toHaveAttribute('href', /trip\/T1/);
			await expect(
				main.getByRole('link', {
					name: fr ? 'Voir ce véhicule sur la carte' : 'See this vehicle on the map',
				}),
			).toHaveAttribute('href', /map\?vehicle=40061/);
			await expect(main.getByText(fr ? 'Peu de places' : 'Few seats')).toBeVisible();
			await page.goto(`${prefix}/vehicle/40062?provider=stm&frameMode=live&${dates}`);
			await expect(
				main.getByText(fr ? /Ce véhicule ne se signale pas/ : /This vehicle is not reporting now/),
			).toBeVisible();
		});
	}
}

test('the fleet names untracked data and vehicle sections stream independently', async ({
	page,
	request,
}) => {
	await page.goto('/vehicles?provider=stm&recordFrom=2026-11-10&recordTo=2026-11-16');
	await expect(page.getByText(/Vehicles are not tracked here/)).toBeVisible();
	const response = await page.goto(
		'/vehicle/40061?provider=stm&recordFrom=2026-11-09&recordTo=2026-11-15',
		{ waitUntil: 'commit' },
	);
	expect(response?.headers()['cache-control']).toBe('no-store, no-transform');
	await expect(page.getByRole('region', { name: 'Days and hours in service' })).toContainText(
		'12.5',
	);
	const lines = page.getByRole('region', { name: 'Lines and trips it ran' });
	await expect(page.locator('[data-slot="record-patience"]')).toContainText(
		'These records take longer',
	);
	const port = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';
	expect((await request.post(`http://127.0.0.1:${port}/__overview/release`)).status()).toBe(204);
	await expect(lines).toContainText('12');
});
