import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
	captureFixture,
	captureTrip,
	captureTripReport,
	captureUrl,
	captureVehicle,
	liveTripsUrl,
} from './capture-fixture';
import { openMapControls, openMapInView } from './map-frame-controls';

type RouteMark = { route_id: string; direction: number; selected: number; muted?: boolean };

async function routeMarks(page: Page): Promise<RouteMark[]> {
	return page.evaluate(() => Reflect.get(window, '__transitMap')?.routeLines() ?? []);
}

for (const locale of ['en', 'fr'] as const) {
	test(`${locale} selects and restores a vehicle, line and running trip`, async ({
		page,
	}, info) => {
		const phone = page.viewportSize()!.width < 1024;
		const width = phone ? 390 : 1440;
		await page.setViewportSize({ width, height: phone ? 844 : 900 });
		const fr = locale === 'fr';
		const city = phone === fr ? 'stm' : 'octranspo';
		const theme = fr ? 'dark' : 'light';
		const [lon, lat] = city === 'stm' ? [-73.6, 45.5] : [-75.69, 45.41];
		const at = Date.parse('2026-11-23T16:00:00Z');
		const first = captureVehicle(at, {
			id: 'report-40061',
			vehicle_id: '40061',
			direction_id: 1,
			stop_id: 'S1',
			latitude: lat,
			longitude: lon,
		});
		const second = {
			...first,
			id: 'report-40062',
			vehicle_id: '40062',
			trip_id: 'T2',
			direction_id: 0,
			longitude: lon + 0.0005,
		};
		let capturedAt = at;
		let position = first;
		const stops = [
			{ id: 'S1', name: 'First Avenue', lat: lat + 0.0005, lon, routes: ['24'] },
			{ id: 'S2', name: 'Market Street', lat: lat + 0.002, lon: lon + 0.002, routes: ['24'] },
		];
		const routeShapes = [0, 1].map((dir) => ({
			dir,
			headsign: dir === 1 ? 'Market' : 'Depot',
			stops: stops.map(({ id }, index) => ({ id, seq: index + 1 })),
			shape: {
				type: 'LineString',
				coordinates: [
					[lon - 0.003, lat - 0.002 + dir * 0.0008],
					[lon, lat],
					[lon + 0.002, lat + 0.002 + dir * 0.0008],
				],
			},
		}));
		const rail = {
			...routeShapes[0],
			stops: [],
			headsign: 'Rail terminal',
			shape: {
				type: 'LineString',
				coordinates: [
					[lon - 0.004, lat + 0.001],
					[lon + 0.004, lat + 0.001],
				],
			},
		};
		const routes = [
			{ id: '24', short: '24', long: 'Market Street', type: 3 },
			{ id: 'rail-fixture', short: 'R', long: 'Rail line', type: city === 'stm' ? 1 : 0 },
		];
		const schedule = {
			date: '2026-11-21',
			routes,
			stops,
			route_directions: { '24': routeShapes, 'rail-fixture': [rail] },
		};
		await page.addInitScript((theme) => localStorage.setItem('theme', theme), theme);
		await page.clock.install({ time: at + 5000 });
		await page.route(captureUrl, (route) =>
			route.fulfill({
				json: captureFixture(capturedAt, { city, vehicle_positions: [position, second] }),
			}),
		);
		await page.route(liveTripsUrl, (route) =>
			route.fulfill({
				json: captureTripReport(city, new Date(at).toISOString(), [
					{ ...captureTrip('T1', '24', []), direction_id: 1 },
					{ ...captureTrip('T2', '24', []), direction_id: 0 },
				]),
			}),
		);
		await page.route('**/api/schedule-edition?**', (route) =>
			route.fulfill({ json: { schedule } }),
		);
		await page.route('**/api/schedule-map?**', (route) =>
			route.fulfill({
				json: { schedule: { date: schedule.date, route_shapes: schedule.route_directions } },
			}),
		);
		await page.route('**/api/stops/slim?**', (route) =>
			route.fulfill({ json: { generated_utc: `${schedule.date}T00:00:00Z`, stops } }),
		);

		const path = `${fr ? '/fr' : ''}/map?provider=${city}`;
		const panel = page.locator('[data-slot="map-detail-overlay"]');
		const clear = panel.getByRole('button', {
			name: fr ? 'Effacer la sélection' : 'Clear selection',
		});
		const evidenceDir = process.env.TRANSIT_MAP_ROUTES_PICTURES;
		const picture = async (stage: string) => {
			if (evidenceDir && ['phone', 'desktop'].includes(info.project.name))
				await page.screenshot({
					path: join(evidenceDir, `${city}-${width}-${locale}-${theme}-${stage}.png`),
				});
		};
		await page.goto(path);
		await openMapInView(page);
		await expect
			.poll(() => routeMarks(page))
			.toEqual(
				expect.arrayContaining([
					expect.objectContaining({ route_id: 'rail-fixture', selected: 0, schedule_only: true }),
				]),
			);
		expect(await page.evaluate(() => Reflect.get(window, '__transitMap')?.railDash)).toEqual(
			expect.arrayContaining([['literal', [1.5, 2]]]),
		);
		await picture('rail');
		const row = page.locator('[data-in-view-vehicle="40061"]');
		await row.click();
		await expect(page).toHaveURL(/selectedVehicle=40061/);
		await expect(panel).toContainText('40061');
		const sharedVehicle = page.url();
		await page.goto(sharedVehicle);
		await expect(panel).toContainText('Market');
		await expect
			.poll(() => routeMarks(page))
			.toEqual(
				expect.arrayContaining([
					expect.objectContaining({ route_id: '24', direction: 1, selected: 1 }),
					expect.objectContaining({ route_id: '24', direction: 0, selected: 0, muted: true }),
					expect.objectContaining({ route_id: 'rail-fixture', selected: 0, muted: true }),
				]),
			);
		await expect(panel.locator('[data-slot="map-next-stops-panel"]')).toContainText('First Avenue');
		await expect
			.poll(() => page.evaluate(() => Reflect.get(window, '__transitMap')?.upcomingStops() ?? []))
			.toContain('S1');
		await picture('vehicle');
		if (!fr) {
			capturedAt = at + 15_000;
			position = {
				...first,
				latitude: lat + 0.001,
				observed_at: new Date(capturedAt).toISOString(),
			};
			await page.clock.fastForward(25_000);
			await expect
				.poll(() => page.evaluate(() => Reflect.get(window, '__transitMap')?.center[1]))
				.toBeCloseTo(lat + 0.001, 5);
		}

		await panel
			.getByRole('button', { name: fr ? 'Voir toute la ligne' : 'Show the whole line' })
			.first()
			.click();
		await expect(page).toHaveURL(/[?&]line=24$/);
		await expect
			.poll(() => routeMarks(page))
			.toEqual(
				expect.arrayContaining([
					expect.objectContaining({ route_id: '24', direction: 0, selected: 1 }),
					expect.objectContaining({ route_id: '24', direction: 1, selected: 1 }),
				]),
			);
		await picture('line');

		const trip = panel.getByRole('combobox', {
			name: fr ? 'Trajet sur cette ligne' : 'Trip on this line',
		});
		await trip.press('ArrowDown');
		await page.getByRole('option', { name: /40062/ }).click();
		await expect(page).toHaveURL(/lineTrip=T2/);
		await expect(panel).toContainText('40062');
		await expect
			.poll(() => routeMarks(page))
			.toEqual(
				expect.arrayContaining([
					expect.objectContaining({ route_id: '24', direction: 0, selected: 1 }),
					expect.objectContaining({ route_id: '24', direction: 1, selected: 0 }),
				]),
			);
		await picture('trip');
		await clear.press('Escape');
		await expect(page).not.toHaveURL(/[?&](line|lineTrip|selectedVehicle)=/);
		await expect(panel).toBeHidden();

		await page.goto(`${path}&selectedVehicle=not-reporting`);
		await expect(
			page.getByText(
				fr
					? 'Ce véhicule ne transmet pas sa position en ce moment.'
					: 'This vehicle is not reporting a position right now.',
			),
		).toBeVisible();
		await openMapControls(page);
		const line = page.getByRole('combobox', {
			name: fr ? 'Ligne sur la carte' : 'Line on the map',
		});
		await line.press('ArrowDown');
		await page.getByRole('option', { name: /^24\b/ }).click();
		await expect(page).toHaveURL(/[?&]line=24$/);
		await page.goto(`${path}&route=24`);
		await expect
			.poll(async () => [...new Set((await routeMarks(page)).map((mark) => mark.route_id))])
			.toEqual(['24']);
	});
}
