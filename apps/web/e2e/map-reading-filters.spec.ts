import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { captureFixture, captureUrl, captureVehicle } from './capture-fixture';
import { closeMapInView, openMapControls, openMapInView } from './map-frame-controls';
import { recordMapFixture, recordMapPeriod } from './map-record-fixture';

const providers = [
	{
		id: 'stm',
		latitude: 45.5,
		longitude: -73.6,
		lines: [
			{ id: '24', short: '24', long: 'Sherbrooke', type: 3 },
			{ id: '51', short: '51', long: 'Édouard-Montpetit', type: 3 },
			{ id: '1', short: '1', long: 'Verte', type: 1 },
		],
		excluded: '80',
	},
	{
		id: 'octranspo',
		latitude: 45.41,
		longitude: -75.69,
		lines: [
			{ id: '6', short: '6', long: 'Greenboro', type: 3 },
			{ id: '7', short: '7', long: 'Carleton', type: 3 },
			{ id: '1-373', short: '1', long: 'O-Train', type: 0 },
		],
		excluded: '75',
	},
] as const;

for (const provider of providers) {
	for (const locale of ['en', 'fr'] as const) {
		test(`${provider.id} ${locale} restores map reading filters and matching vehicles @theme`, async ({
			page,
		}, info) => {
			const fr = locale === 'fr';
			const now = Date.now();
			const hour = Number(
				new Intl.DateTimeFormat('en', {
					hour: 'numeric',
					hourCycle: 'h23',
					timeZone: 'America/Toronto',
				}).format(now),
			);
			const [first, second, rail] = provider.lines;
			await page.clock.setFixedTime(now + 5_000);
			await page.route(`**/api/schedule-edition?city=${provider.id}`, (route) =>
				route.fulfill({
					json: {
						schedule: {
							date: '2026-11-21',
							routes: provider.lines,
							stops: [],
							route_directions: {},
						},
					},
				}),
			);
			await page.route(captureUrl, (route) =>
				route.fulfill({
					json: captureFixture(now, {
						city: provider.id,
						vehicle_positions: [
							['40061', first.id, 0],
							['40062', second.id, 0],
							['40063', first.id, 1],
							['40064', rail.id, 0],
							['40065', provider.excluded, 0],
						].map(([id, line, direction], index) =>
							captureVehicle(now, {
								id: String(id),
								vehicle_id: String(id),
								route_id: String(line),
								direction_id: Number(direction),
								latitude: provider.latitude + index / 1000,
								longitude: provider.longitude,
							}),
						),
					}),
				}),
			);

			const params = new URLSearchParams({
				provider: provider.id,
				route: provider.lines.map(({ id }) => id).join(','),
				vehicleType: '3',
				timeOfDay: `${hour}-${hour + 1}`,
				mapDirection: '0',
			});
			for (const width of [390, 1440]) {
				await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
				await page.goto(`${fr ? '/fr' : ''}/map?${params}`);
				await openMapInView(page);
				const rows = page.locator('[data-report-row]:visible');
				await expect(rows).toHaveCount(2);
				await expect(rows.locator('a[data-in-view-vehicle="40061"]')).toBeVisible();
				await expect(rows.locator('a[data-in-view-vehicle="40062"]')).toBeVisible();
				if (width < 1024) await closeMapInView(page);
				await openMapControls(page);
				await page.locator('[data-map-filter-trigger]').click();
				const panel = page.locator('.map-filters:visible');
				const type = panel.getByRole('combobox', {
					name: fr ? 'Type de véhicule' : 'Vehicle type',
					exact: true,
				});
				const time = panel.getByRole('combobox', {
					name: fr ? 'Moment de la journée' : 'Time of day',
					exact: true,
				});
				const direction = panel.getByRole('combobox', {
					name: fr ? 'Sens' : 'Direction',
					exact: true,
				});
				await expect(type).toHaveValue('3');
				await expect(
					type.locator('option', { hasText: provider.id === 'stm' ? 'Métro' : 'O-Train' }),
				).toHaveCount(1);
				await expect(time).toHaveValue('custom');
				await expect(
					panel.getByRole('combobox', { name: fr ? 'De' : 'From', exact: true }),
				).toHaveValue(String(hour));
				await expect(
					panel.getByRole('combobox', { name: fr ? 'Jusqu’à' : 'Until', exact: true }),
				).toHaveValue(String(hour + 1));
				await expect(direction).toHaveValue('0');
				const active = panel.locator(
					'[data-filter-group="active"] .mf-active-set button[aria-label]',
				);
				await expect(active).toHaveCount(3);

				const evidence = process.env.TRANSIT_K2_PICTURES;
				if (evidence) {
					if (width < 1024)
						await type.evaluate((select) => {
							const label = select.closest('label');
							const tab = select.closest<HTMLElement>('[role="tabpanel"]');
							if (!label || !tab) throw new Error('Map filters are outside the controls tab');
							tab.scrollTop += label.getBoundingClientRect().top - tab.getBoundingClientRect().top;
						});
					await page.screenshot({
						path: join(evidence, `${provider.id}-${locale}-${width}-${info.project.name}.png`),
						animations: 'disabled',
					});
				}

				if (width === 1440) {
					if (provider.id === 'stm' && !fr) {
						await active.filter({ hasText: '51' }).click();
						await expect(active).toHaveCount(2);
						await panel.getByRole('button', { name: 'Add a line filter', exact: true }).click();
						await page.getByRole('option', { name: /^51\b/u }).click();
						await expect(active).toHaveCount(3);
					}
					const outsideBand = hour < 19 ? 'evening' : 'morning';
					await time.selectOption(outsideBand);
					await expect
						.poll(() => new URL(page.url()).searchParams.get('timeOfDay'))
						.toBe(outsideBand);
					await expect(type).toHaveValue('3');
					await expect(direction).toHaveValue('0');
					await expect(rows).toHaveCount(0);
				}
			}
		});
	}
}

test('Record sends the chosen period and reading filters for Stops and Corridors', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const received = await recordMapFixture(page);
	await page.goto(
		`/map?${recordMapPeriod}&route=24,51&vehicleType=3&timeOfDay=22-6&mapDirection=1&recordDirection=1`,
	);
	await openMapControls(page);
	const filters = ['["24","51"]', '3', '22', '6', '1'];
	const keys = ['lines', 'route_type', 'hour_from', 'hour_to', 'direction'];
	await expect.poll(() => keys.map((key) => received.at(-1)?.get(key))).toEqual(filters);
	expect(received.at(-1)?.get('from')).toBe('2026-11-18');
	expect(received.at(-1)?.get('to')).toBe('2026-11-21');
	await page.getByRole('radio', { name: 'Corridors' }).click();
	await expect.poll(() => received.at(-1)?.get('layer')).toBe('corridors');
	await expect.poll(() => keys.map((key) => received.at(-1)?.get(key))).toEqual(filters);
	await page.locator('[data-map-filter-trigger]').click();
	const panel = page.locator('.map-filters:visible');
	await expect(panel.getByRole('combobox', { name: 'Time of day', exact: true })).toHaveValue(
		'custom',
	);
	const direction = panel.getByRole('combobox', { name: 'Direction', exact: true });
	await expect(direction).toHaveValue('1');
	await direction.selectOption('0');
	await expect(page).toHaveURL(/[?&]mapDirection=0(?:&|$)/);
	await expect(page).not.toHaveURL(/[?&]recordDirection=/);
	await expect.poll(() => received.at(-1)?.get('direction')).toBe('0');
});
