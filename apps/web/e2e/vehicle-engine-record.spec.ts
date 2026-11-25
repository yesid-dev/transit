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
				main.getByRole('article', {
					name: fr ? 'Jours et heures en service' : 'Days and hours in service',
				}),
			).toContainText(fr ? '12,5' : '12.5');
			await expect(
				main.getByRole('region', {
					name: fr ? 'Lignes et trajets effectués' : 'Lines and trips it ran',
				}),
			).toContainText('12');
			await expect(
				main.getByRole('article', {
					name: fr ? 'Interruptions de signalement' : 'Stopped reporting',
				}),
			).toContainText(fr ? '16 interruptions par 100 heures' : '16 interruptions per 100 hours');
			const completion = main.getByRole('article', {
				name: fr ? 'Trajets non terminés' : 'Trips it did not finish',
			});
			await expect(completion).toContainText(fr ? 'Non suivi' : 'Not tracked');
			await expect(completion).toContainText(
				fr
					? 'Les flux en direct ne montrent pas de façon fiable quand un trajet se termine tôt'
					: 'The live feeds do not show reliably when a trip ends early',
			);
			await expect(completion).not.toContainText(fr ? 'sur 20 trajets' : 'of 20 trips');
			const timing = main.getByRole('article', {
				name: fr ? 'Son bilan de ponctualité' : 'Its on-time record',
			});
			await expect(timing).toContainText(
				fr ? 'les lignes et les heures qu’on lui confie' : 'the lines and hours it is assigned to',
			);
			await expect(timing).toContainText(
				fr ? 'Trop peu de données pour conclure' : 'Too few to judge',
			);
			await expect(
				main.getByRole('list', { name: fr ? 'Jours en service' : 'Days in service' }),
			).toContainText(fr ? '2,5' : '2.5');
			await expect(
				main.locator(
					'[data-slot="day-strip-cell"][data-reported="true"] [style*="block-size: 100%"]',
				),
			).toHaveCount(5);
			await expect(main.locator('[data-slot="screen-answer"]')).toContainText(
				fr ? '22 trajets, 5 jours en service' : '22 trips, 5 days in service',
			);
			await main.getByRole('button', { name: fr ? 'Citer' : 'Cite', exact: true }).click();
			await expect(page.getByRole('dialog')).toContainText(/v1[\s\S]*#punctuality/);
			await page.getByRole('button', { name: fr ? 'Fermer' : 'Close', exact: true }).click();
			await main
				.getByRole('button', { name: fr ? 'Télécharger' : 'Download', exact: true })
				.click();
			const href = await page
				.getByRole('dialog')
				.getByRole('link', { name: fr ? 'Son bilan de ponctualité' : 'Its on-time record' })
				.getAttribute('href');

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
			let editionDate = '';
			await page.route(/\/api\/schedule-map\?/, (route) =>
				route.fulfill({
					json: {
						schedule: {
							date: editionDate,
							route_shapes: {
								80: [
									{
										dir: 1,
										headsign: 'Parc',
										shape: {
											type: 'LineString',
											coordinates: [
												[-73.601, 45.499],
												[-73.6, 45.5],
												[-73.599, 45.501],
											],
										},
									},
								],
							},
						},
					},
				}),
			);
			await page.route(/\/api\/schedule-edition\?city=stm$/, async (route) => {
				const response = await route.fetch();
				const { schedule } = await response.json();
				editionDate = schedule.date;
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
			await expect(main.locator('[data-slot="screen-answer"]')).toContainText(
				fr ? '4 min de retard' : '4 min late',
			);
			await expect(main.locator('[data-slot="still-map"] polyline')).toBeVisible();

			await expect(
				main.getByRole('button', { name: fr ? 'Voir les prévisions' : 'View predictions' }),
			).toBeVisible();
			await expect(
				main.getByRole('link', {
					name: fr ? 'Ouvrir la carte sur ce véhicule' : 'Open the full map on this vehicle',
				}),
			).toHaveAttribute('href', /map\?vehicle=40061/);
			await expect(main.getByText(fr ? 'Peu de places' : 'Few seats')).toBeVisible();
			await expect(
				main.getByRole('link', {
					name: fr ? 'Son bilan pour les dates choisies' : 'Its record over the chosen dates',
				}),
			).toHaveAttribute('href', /frameMode=record.*recordFrom=2026-11-08.*recordTo=2026-11-14/);
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
	await expect(page.getByRole('article', { name: 'Days and hours in service' })).toContainText(
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

test('a vehicle without reports has a state in both languages', async ({ page }) => {
	for (const lang of ['en', 'fr']) {
		await page.goto(
			`${lang === 'fr' ? '/fr' : ''}/vehicle/1?provider=octranspo&frameMode=record&${dates}`,
		);
		const answer = page.locator('[data-slot="screen-answer"]');
		await expect(answer).toContainText(
			lang === 'fr' ? 'Aucun signalement à ces dates.' : 'Did not report on these dates.',
		);
		await expect(answer.locator('[data-record-state="not_reporting"]')).toBeVisible();
		await expect(answer).not.toContainText(/\b0\b/);
	}
});

for (const locale of ['en', 'fr'] as const) {
	const fr = locale === 'fr';
	const prefix = fr ? '/fr' : '';
	test(`${locale} Vehicle distinguishes an unpublished day from a measured day without a report`, async ({
		page,
	}) => {
		await page.goto(`${prefix}/vehicle/40064?provider=stm&frameMode=record&${dates}`);
		const answer = page.locator('[data-slot="screen-answer"]');
		await expect(answer).toContainText(fr ? '6 sur 6' : '6 of 6');
		await expect(answer).toContainText(fr ? 'jours mesurés' : 'measured days');
		await expect(answer).not.toContainText(fr ? 'Le jour restant' : 'On the other day');
		await expect(
			page.getByRole('article', { name: fr ? 'Jour après jour' : 'Day by day' }),
		).toContainText(
			fr ? '6 jours en service sur 6 jours mesurés' : '6 days in service of 6 measured days',
		);
		await expect(
			page.getByRole('article', {
				name: fr ? 'Interruptions de signalement' : 'Stopped reporting',
			}),
		).toContainText(fr ? '130,8' : '130.8');
		await page.goto(`${prefix}/vehicle/40065?provider=stm&frameMode=record&${dates}`);
		await expect(answer).toContainText(fr ? '5 sur 6' : '5 of 6');
		await expect(answer).toContainText(fr ? 'Le jour restant' : 'On the other day');
		const days = page.getByRole('article', { name: fr ? 'Jour après jour' : 'Day by day' });
		await expect(days.locator('[data-slot="day-strip-cell"][data-reported="false"]')).toContainText(
			fr ? 'Non mesuré' : 'Not measured',
		);
		await expect(days.getByText('◇', { exact: true })).toHaveCount(2);
		await page.goto(`${prefix}/vehicle/40067?provider=stm&frameMode=record&${dates}`);
		await expect(answer).toContainText(
			fr ? 'Aucun signalement les jours mesurés.' : 'Did not report on the measured days.',
		);
	});

	test(`${locale} Vehicle busy answer shows the shared pending line`, async ({ page }) => {
		await page.goto(`${prefix}/vehicle/40066?provider=stm&frameMode=record&${dates}`);
		await expect(page.locator('[data-slot="screen-answer"]')).toHaveText(
			fr ? 'Lecture en attente.' : 'Waiting for a reading.',
		);
		await expect(page.locator('[data-slot="record-patience"]')).toHaveCount(1);
		await expect(page.locator('[data-slot="record-patience"]')).toContainText(
			fr ? 'Ce bilan demande plus de temps' : 'These records take longer',
		);
	});
}
