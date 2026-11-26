import { expect, test } from '@playwright/test';
import { textDefects } from './layout-helpers';
import {
	captureFixture,
	captureTrip,
	captureTripReport,
	captureUrl,
	captureVehicle,
	liveTripsUrl,
} from './capture-fixture';

test.use({ bypassCSP: true });
test.beforeEach(({ browserName }, info) => {
	test.skip(browserName !== 'chromium' || info.project.name !== 'desktop');
});

const dates = 'recordFrom=2026-11-08&recordTo=2026-11-14';

for (const locale of ['en', 'fr'] as const) {
	test(`Vehicle service starts with a short line list in ${locale}`, async ({ page }) => {
		const fr = locale === 'fr';
		await page.goto(
			`${fr ? '/fr' : ''}/vehicle/40061?provider=stm&frameMode=record&recordFrom=2026-11-07&recordTo=2026-11-13`,
		);
		const lines = page.getByRole('region', {
			name: fr ? 'Lignes et trajets effectués' : 'Lines and trips it ran',
		});
		const links = lines.getByRole('link');
		await expect(links).toHaveCount(3);
		await expect(lines).toContainText(fr ? '3 sur 5' : 'Showing 3 of 5');
		await lines.getByRole('button', { name: fr ? 'Afficher 2 de plus' : 'Show 2 more' }).click();
		await expect(links).toHaveCount(5);
		await expect(lines.locator('tbody tr').nth(3)).toBeFocused();
	});
}

test('vehicle live links its scheduled departure and keeps predictions in their sheet', async ({
	page,
}) => {
	const now = Date.now();
	let hasTime = true;
	await page.route(captureUrl, (route) =>
		route.fulfill({ json: captureFixture(now, { vehicle_positions: [captureVehicle(now)] }) }),
	);
	await page.route(liveTripsUrl, (route) =>
		route.fulfill({
			json: captureTripReport('stm', new Date(now).toISOString(), [
				{
					...captureTrip(
						'T1',
						'24',
						['S1', 'S2', 'S3', 'S4'].map((stop, index) => ({
							stop,
							eta_utc: new Date(now + (index + 1) * 60_000).toISOString(),
							delay_min: 4,
						})),
					),
					direction_id: 1,
					start_time: hasTime ? '07:38:00' : null,
					trip_headsign: 'Station Laurier',
				},
			]),
		}),
	);
	const path = `/vehicle/40061?provider=stm&frameMode=live&${dates}`;
	await page.goto(path);
	const service = page.getByRole('article', { name: 'What it is running' });
	await expect(service.locator('[data-slot="fact-list"]')).toHaveCount(1);
	await expect(service.locator('dt')).toHaveText([
		'Line',
		'Scheduled departure',
		'Status',
		'Next stop',
		'How full it is',
		'Last report',
	]);
	await expect(
		service.getByRole('link', { name: '07:38 toward Station Laurier', exact: true }),
	).toHaveAttribute('href', /\/departure\/[^?]+\?.*trip=T1/);
	await expect(service.locator('table')).toHaveCount(0);
	await service.getByRole('button', { name: 'Predictions at its next stops' }).click();
	await expect(page.getByRole('dialog').locator('table tbody tr')).toHaveCount(4);

	hasTime = false;
	await page.goto(path);
	// A missing time is a state, not a link; the departure keeps its own link.
	await expect(service.getByRole('link', { name: 'Departure time not published' })).toHaveCount(0);
	await expect(service.locator('[data-slot="departure-time-missing"]')).toHaveText(
		'Departure time not published',
	);
	const fallback = service.getByRole('link', { name: 'This departure', exact: true });
	await expect(fallback).toHaveAttribute('href', /\/departure\/trip\?.*trip=T1/);
	await fallback.click();
	await expect(page.getByRole('heading', { level: 1, name: 'Departure' })).toBeVisible();
	await expect(page.getByRole('main').locator('table tbody tr')).toHaveCount(4);
});

const fleetDates = 'recordFrom=2026-11-04&recordTo=2026-11-10';

test('the vehicle fleet sends only the first page and marks an absent report', async ({
	page,
	request,
}) => {
	const path = `/vehicles?provider=stm&frameMode=record&${fleetDates}`;
	const response = await request.get(path);
	expect(response.ok()).toBe(true);
	const html = await response.text();
	expect(new Set(html.match(/49-3\d\d/g)).size).toBe(20);
	expect(html).not.toContain('49-346');
	await page.goto(path);
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
	await expect(page.locator('[data-slot="screen-answer"]')).toContainText(
		/46\s+vehicles reported on a trip on these dates\./,
	);
	const rows = page.locator('#fleet tbody tr');
	await expect(rows).toHaveCount(20);
	const first = rows.first();
	await expect(
		first.locator('[data-column="days"] [data-record-state="not_reporting"]'),
	).toBeVisible();
	await expect(first.getByText('0', { exact: true })).toHaveCount(0);
	await expect(first.locator('[data-column="days"]')).toContainText('Did not report');
	for (const column of ['hours', 'lines', 'trips']) {
		await expect(first.locator(`[data-column="${column}"] .data-table-cell-content`)).toBeEmpty();
	}
	await expect(rows.nth(1).locator('[data-column="days"]')).toContainText('2 of 7');
	await page.getByRole('button', { name: 'Show 20 more', exact: true }).click();
	await expect(rows).toHaveCount(40);
	await expect(rows.nth(20).getByRole('link')).toBeFocused();
});

test('the live fleet pages the reporting vehicles and names delay unknown', async ({ page }) => {
	const now = Date.now();
	await page.route(captureUrl, (route) =>
		route.fulfill({
			json: captureFixture(now, {
				vehicle_positions: Array.from({ length: 25 }, (_, index) =>
					captureVehicle(now, {
						id: `fleet-${index}`,
						vehicle_id: `56-${350 + index}`,
						delay: index ? 240 : null,
					}),
				),
			}),
		}),
	);
	await page.goto('/vehicles?provider=stm&frameMode=live');
	await expect(page.locator('[data-slot="screen-answer"]')).toContainText(
		/25\s*vehicles are reporting now/,
	);
	const rows = page.locator('#vehicles-live tbody tr');
	await expect(rows).toHaveCount(20);
	await expect(rows.first().locator('[data-column="status"]')).toContainText('Delay unknown');
	await page.getByRole('button', { name: 'Show 5 more', exact: true }).click();
	await expect(rows).toHaveCount(25);
});
for (const width of [390, 1440]) {
	for (const locale of ['en', 'fr']) {
		const fr = locale === 'fr';
		const prefix = fr ? '/fr' : '';
		const search = fr ? 'Numéro de véhicule' : 'Vehicle number';
		test(`${locale} at ${width}px searches the fleet and opens a citable vehicle record`, async ({
			page,
			request,
		}) => {
			await page.setViewportSize({ width, height: 900 });
			await page.goto(`${prefix}/vehicles?provider=stm&frameMode=record&${dates}`);
			const main = page.getByRole('main');
			const table = main.getByRole('table');
			await expect(table.getByRole('rowheader')).toHaveCount(2, { timeout: 15_000 });
			await expect(main.locator('[data-slot="screen-answer"]')).toContainText(
				fr
					? /2\s+véhicules ont signalé une position pendant un trajet à ces dates\./
					: /2\s+vehicles reported on a trip on these dates\./,
			);
			await main.getByRole('searchbox', { name: search }).fill('0061');
			await expect(table.getByRole('rowheader')).toHaveCount(1);
			const first = table
				.getByRole('row')
				.filter({ has: page.getByRole('link', { name: '40061', exact: true }) });
			if (width === 390) {
				// The phone row: days in service as its value, the rest as one sentence.
				await expect(first).toContainText(fr ? /5 sur \d+ jours/u : /5 of \d+ days/u);
				await expect(first).toContainText(fr ? '22 trajets' : '22 trips');
			} else {
				await expect(first.locator('[data-column="days"]')).toContainText('5');
				await expect(first.locator('[data-column="trips"]')).toContainText('22');
			}
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
			).toContainText(
				fr
					? 'interruptions des signalements, environ 0,2 par heure'
					: 'times it stopped reporting, about 0.2 an hour',
			);
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
				main.getByRole('button', {
					name: fr ? 'Prévisions à ses prochains arrêts' : 'Predictions at its next stops',
				}),
			).toBeVisible();
			if (width === 1440) {
				await page.evaluate(() => document.fonts.ready);
				const service = main.getByRole('article', {
					name: fr ? 'Son service en cours' : 'What it is running',
				});
				const rows = service
					.locator('[data-slot="fact-list"]')
					.first()
					.locator('[data-slot="fact-row"]');
				const heights = await rows.evaluateAll((items) =>
					items.map((item) => Math.round(item.getBoundingClientRect().height)),
				);
				expect(heights).toHaveLength(6);
				expect(heights.every((height) => height >= 44)).toBe(true);
				const line = rows.first();
				const rowBox = (await line.boundingBox())!;
				const linkBox = (await line.getByRole('link').boundingBox())!;
				expect(linkBox.x + linkBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
			}
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
			page.getByRole('article', { name: fr ? 'Jour par jour' : 'Day by day' }),
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
		const days = page.getByRole('article', { name: fr ? 'Jour par jour' : 'Day by day' });
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
			fr ? 'En attente de données.' : 'Waiting for a reading.',
		);
		await expect(page.locator('[data-slot="record-patience"]')).toHaveCount(1);
		await expect(page.locator('[data-slot="record-patience"]')).toContainText(
			fr ? 'Ce bilan demande plus de temps' : 'These records take longer',
		);
	});

	test(`${locale} narrow vehicle fleet tables keep name, value and 44px links clear at 320 and 390px`, async ({
		page,
	}) => {
		const now = Date.now();
		await page.route(captureUrl, (route) =>
			route.fulfill({
				json: captureFixture(now, {
					vehicle_positions: [
						captureVehicle(now, { id: 'narrow-1', vehicle_id: '56-350', delay: null }),
						captureVehicle(now, { id: 'narrow-2', vehicle_id: '56-351', delay: 240 }),
					],
				}),
			}),
		);
		const modes = [
			{
				label: 'record',
				url: `${prefix}/vehicles?provider=stm&frameMode=record&${fleetDates}`,
				table: '#fleet table',
			},
			{
				label: 'live',
				url: `${prefix}/vehicles?provider=stm&frameMode=live`,
				table: '#vehicles-live table',
			},
		] as const;

		for (const item of modes) {
			for (const width of [320, 390]) {
				await page.setViewportSize({ width, height: 900 });
				await page.goto(item.url);
				await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
				const table = page.locator(item.table);
				await expect(table.locator('tbody tr').first()).toBeVisible();
				await page.evaluate(() => document.fonts.ready);

				const check = await table.evaluate((tableEl) => {
					const rows = [...tableEl.querySelectorAll('tbody tr')].slice(0, 6);
					let minPrimaryWidth = Infinity;
					let minLinkHeight = Infinity;
					let labelOverlapsValue = false;
					for (const row of rows) {
						const primary = row.querySelector<HTMLElement>('[data-row-position="primary"]');
						const value = row.querySelector<HTMLElement>('[data-row-position="value"]');
						const link = row.querySelector<HTMLElement>('a.name-cell');
						const name = row.querySelector<HTMLElement>('.name-label');
						if (primary)
							minPrimaryWidth = Math.min(minPrimaryWidth, primary.getBoundingClientRect().width);
						if (link) minLinkHeight = Math.min(minLinkHeight, link.getBoundingClientRect().height);
						if (name && value) {
							const nr = name.getBoundingClientRect();
							const vr = value.getBoundingClientRect();
							if (nr.right > vr.left + 1 && nr.top < vr.bottom - 1 && nr.bottom > vr.top + 1) {
								labelOverlapsValue = true;
							}
						}
					}
					return {
						rowCount: rows.length,
						pageOverflow:
							document.documentElement.scrollWidth - document.documentElement.clientWidth,
						minPrimaryWidth: Math.round(minPrimaryWidth),
						minLinkHeight: Math.round(minLinkHeight),
						labelOverlapsValue,
					};
				});
				expect(check.rowCount, `${locale} ${item.label} ${width}px rows`).toBeGreaterThan(0);
				expect(
					check.pageOverflow,
					`${locale} ${item.label} ${width}px overflow`,
				).toBeLessThanOrEqual(0);
				expect(
					check.minPrimaryWidth,
					`${locale} ${item.label} ${width}px name track`,
				).toBeGreaterThanOrEqual(100);
				expect(
					check.minLinkHeight,
					`${locale} ${item.label} ${width}px link height`,
				).toBeGreaterThanOrEqual(44);
				expect(
					check.labelOverlapsValue,
					`${locale} ${item.label} ${width}px label/value overlap`,
				).toBe(false);
				const tablePrefix = item.table.split(' ')[0];
				const defects = (await textDefects(page)).filter(
					({ kind, selector }) => kind === 'broken-word' && selector.startsWith(tablePrefix),
				);
				expect(defects, `${locale} ${item.label} ${width}px broken words`).toEqual([]);
			}
		}
	});
}
