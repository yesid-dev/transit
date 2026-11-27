import { expect, test, type Locator } from '@playwright/test';
import { join } from 'node:path';
import {
	captureFixture,
	captureTrip,
	captureTripReport,
	captureUrl,
	captureVehicle,
	liveTripsUrl,
} from './capture-fixture';

// Longest headsigns in the published STM and OC Transpo schedule editions for 26 November 2026.
const fixtures = [
	{
		city: 'stm',
		line: '747',
		latitude: 45.5,
		longitude: -73.6,
		destination: 'Est - Vers le centre-ville de Montréal trajet 1 gare d’autocars de Montréal',
		match: 'gare d’autocars de Montréal',
	},
	{
		city: 'octranspo',
		line: '98',
		latitude: 45.41,
		longitude: -75.69,
		destination: 'South Keys / Hunt Club Loop ~ South Keys / Boucle Hunt Club',
		match: 'Hunt Club',
	},
] as const;

async function expectFits(panel: Locator) {
	await expect(panel).toBeVisible();
	await expect
		.poll(() => panel.evaluate((node) => node.scrollWidth - node.clientWidth))
		.toBeLessThanOrEqual(0);
}

for (const fixture of fixtures) {
	for (const locale of ['en', 'fr'] as const) {
		test(`${fixture.city} ${locale} map panels fit long destinations and keep the delay visible @theme`, async ({
			page,
		}, info) => {
			const fr = locale === 'fr';
			const now = Date.now();
			const vehicleId = '40061';
			await page.clock.setFixedTime(now + 5_000);
			await page.route(captureUrl, (route) =>
				route.fulfill({
					json: captureFixture(now, {
						city: fixture.city,
						vehicle_positions: [
							captureVehicle(now, {
								vehicle_id: vehicleId,
								route_id: fixture.line,
								latitude: fixture.latitude,
								longitude: fixture.longitude,
								direction_id: 0,
								delay: 660,
							}),
						],
					}),
				}),
			);
			await page.route(liveTripsUrl, (route) =>
				route.fulfill({
					json: captureTripReport(fixture.city, new Date(now).toISOString(), [
						{ ...captureTrip('T1', fixture.line, []), direction_id: 0 },
					]),
				}),
			);
			await page.route(`**/api/schedule-edition?city=${fixture.city}`, async (route) => {
				const response = await route.fetch();
				const body = await response.json();
				if (!body.schedule.routes.some(({ id }: { id: string }) => id === fixture.line))
					body.schedule.routes.push({ id: fixture.line, short: fixture.line, type: 3 });
				body.schedule.route_directions[fixture.line] = [{ dir: 0, headsign: fixture.destination }];
				await route.fulfill({ response, json: body });
			});

			await page.setViewportSize({ width: 1024, height: 900 });
			await page.goto(`${fr ? '/fr' : ''}/map?provider=${fixture.city}`);
			const left = page
				.locator('[data-slot="surface-rail"]')
				.filter({ has: page.locator('[data-frame-controls="desktop"]') });
			const right = page.locator('aside[data-slot="map-details"]');
			const row = right.locator(`[data-report-id="${vehicleId}"]`);
			const delay = row.locator('[data-map-row-value]');
			const destination = row.locator('small');
			const selection = page.locator('[data-slot="map-detail-overlay"]');

			for (const width of [1024, 1280, 1440, 1920]) {
				await page.setViewportSize({ width, height: 900 });
				await expect(destination).toContainText(fixture.match);
				await expect(delay).toBeVisible();
				await expect(delay).toContainText(/11\s*min/u);
				await expectFits(left);
				await expectFits(right);
				expect(
					await delay.evaluate((column) => {
						const pane = column.closest('aside[data-slot="map-details"]')!;
						const limit = pane.getBoundingClientRect().left + pane.clientLeft + pane.clientWidth;
						return Math.round(column.getBoundingClientRect().right - limit);
					}),
				).toBeLessThanOrEqual(0);
				if (width === 1024 && fixture.city === 'stm') {
					expect(
						await destination.evaluate((node) => {
							const range = document.createRange();
							range.selectNodeContents(node);
							return range.getClientRects().length;
						}),
					).toBeGreaterThan(1);
				}
				const evidence = process.env.TRANSIT_MAP_PANEL_EVIDENCE_DIR;
				if (
					evidence &&
					width === 1440 &&
					!fr &&
					fixture.city === 'stm' &&
					info.project.name === 'dark'
				)
					await page.screenshot({ path: join(evidence, 'stm-en-1440.png') });

				await row.getByRole('link', { name: vehicleId }).click();
				await expect(selection.getByText(fixture.match, { exact: false })).toBeVisible();
				await expectFits(selection);
				await expectFits(right);
				await expectFits(left);
				await selection
					.getByRole('button', { name: fr ? 'Effacer la sélection' : 'Clear selection' })
					.click();
				await expect(selection).toBeHidden();
			}
		});
	}
}
