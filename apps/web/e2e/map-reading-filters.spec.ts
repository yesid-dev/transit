import { expect, test, type Locator } from '@playwright/test';
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
		destinations: ['Station Fairview-Pointe-Claire (Ouest)', 'Station Laurier'],
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
		destinations: ['Greenboro Station via Bank Street', 'Carleton'],
		excluded: '75',
	},
] as const;

async function expectLabelToFit(field: Locator) {
	const clipped = await field.evaluate(async (element) => {
		await document.fonts.ready;
		const fieldBox = element.getBoundingClientRect();
		const text = document.createRange();
		text.selectNodeContents(element);
		return [...text.getClientRects()].some(
			(box) =>
				box.left < fieldBox.left - 0.5 ||
				box.right > fieldBox.right + 0.5 ||
				box.top < fieldBox.top - 0.5 ||
				box.bottom > fieldBox.bottom + 0.5,
		);
	});
	expect(clipped).toBe(false);
}

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
							route_directions: Object.fromEntries(
								[first, second].map((line, index) => [
									line.id,
									[
										{ dir: 0, headsign: provider.destinations[index], stops: [] },
										{ dir: 1, headsign: fr ? 'Centre-ville' : 'Downtown', stops: [] },
									],
								]),
							),
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
				const direction = panel.locator(
					'[data-map-direction-filter] [data-slot="combobox-trigger"]',
				);
				await expect(type).toHaveValue('3');
				await expect(
					type.locator('option', {
						hasText: provider.id === 'stm' ? 'Métro' : fr ? 'Train léger' : 'Light rail',
					}),
				).toHaveCount(1);
				await expect(time).toHaveValue('custom');
				await expect(
					panel.getByRole('combobox', { name: fr ? 'De' : 'From', exact: true }),
				).toHaveValue(String(hour));
				await expect(
					panel.getByRole('combobox', { name: fr ? 'Jusqu’à' : 'Until', exact: true }),
				).toHaveValue(String(hour + 1));
				await expect(direction).toBeDisabled();
				await expect(direction).toContainText(
					fr
						? 'Choisissez une seule ligne pour choisir un sens.'
						: 'Choose one line to pick a direction.',
				);
				await expectLabelToFit(direction);
				const fromHour = panel.getByRole('combobox', { name: fr ? 'De' : 'From', exact: true });
				await expect(fromHour.locator('option[value="17"]')).toHaveText(fr ? '17 h' : '17:00');
				await expect(page.locator('[data-map-reading-line-picker]:visible')).toHaveCount(1);
				const overflow = await panel.evaluate(async (root) => {
					await document.fonts.ready;
					const right = root.getBoundingClientRect().right;
					const text = document.createElement('canvas').getContext('2d')!;
					const controls = root.querySelectorAll(
						'select, [data-map-reading-line-picker], [data-map-direction-filter]',
					);
					return {
						panel: root.scrollWidth - root.clientWidth,
						clippedSelects: [...root.querySelectorAll('select')].filter((select) => {
							const style = getComputedStyle(select);
							text.font = style.font;
							const label = select.selectedOptions[0]?.textContent ?? '';
							const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
							return text.measureText(label).width > select.clientWidth - padding;
						}).length,
						fields: [...controls].filter(
							(control) => control.getBoundingClientRect().right > right + 0.5,
						).length,
					};
				});
				expect(overflow.panel).toBe(0);
				expect(overflow.fields).toBe(0);
				expect(overflow.clippedSelects).toBe(0);
				const tags = panel.locator('[data-map-selected-lines] button[aria-label]');
				await expect(tags).toHaveCount(3);
				await expect(
					panel.getByRole('button', {
						name: fr ? `Retirer la ligne ${first.short}` : `Remove line ${first.short}`,
						exact: true,
					}),
				).toBeVisible();
				const tapTargets = await tags.evaluateAll((buttons) =>
					buttons.map((button) => {
						const { width, height } = button.getBoundingClientRect();
						return Math.min(width, height);
					}),
				);
				expect(Math.min(...tapTargets)).toBeGreaterThanOrEqual(44);
				const tag = (number: string) =>
					tags.filter({ has: page.getByText(number, { exact: true }) });
				const picker = panel.getByRole('button', {
					name: fr ? 'Ajouter une ligne au filtre' : 'Add a line filter',
					exact: true,
				});
				await expect(tag(first.short)).toBeVisible();
				await expect(tag(second.short)).toBeVisible();
				expect((await tags.last().boundingBox())!.y).toBeLessThan((await picker.boundingBox())!.y);

				const evidence = process.env.TRANSIT_K2_PICTURES;
				if (evidence) {
					await tags.first().scrollIntoViewIfNeeded();
					await page.screenshot({
						path: join(evidence, `${provider.id}-${locale}-${width}-${info.project.name}.png`),
						animations: 'disabled',
					});
				}

				await tag(second.short).click();
				await tag(rail.short).click();
				await expect(tags).toHaveCount(1);
				await expect(direction).toBeEnabled();
				await direction.click();
				await page.getByRole('option', { name: provider.destinations[0] }).click();
				await expect(direction).toContainText(provider.destinations[0], { ignoreCase: true });
				await expectLabelToFit(direction);
				await expect(page).toHaveURL(/[?&]mapDirection=0(?:&|$)/);
				if (evidence) {
					await direction.scrollIntoViewIfNeeded();
					await page.screenshot({
						path: join(
							evidence,
							'single-line',
							`${provider.id}-${locale}-${width}-${info.project.name}.png`,
						),
						animations: 'disabled',
					});
				}

				if (width === 1440) {
					await picker.click();
					await page
						.getByRole('listbox', {
							name: fr ? 'Ajouter une ligne au filtre' : 'Add a line filter',
						})
						.getByRole('option', { name: new RegExp(`^${second.short}\\b`, 'u') })
						.click();
					await expect(tags).toHaveCount(2);
					await expect(direction).toBeDisabled();
					await expect(page).not.toHaveURL(/[?&]mapDirection=/);
					const outsideBand = hour < 19 ? 'evening' : 'morning';
					await time.selectOption(outsideBand);
					await expect
						.poll(() => new URL(page.url()).searchParams.get('timeOfDay'))
						.toBe(outsideBand);
					await expect(type).toHaveValue('3');
					await expect(direction).toBeDisabled();
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
	const direction = panel.locator('[data-map-direction-filter] [data-slot="combobox-trigger"]');
	await expect(direction).toBeDisabled();
	await panel.locator('[data-map-selected-lines] button').filter({ hasText: '51' }).click();
	await expect(direction).toBeEnabled();
	await direction.click();
	await page.getByRole('option', { name: /Jean-Talon/u }).click();
	await expect(page).toHaveURL(/[?&]mapDirection=0(?:&|$)/);
	await expect(page).not.toHaveURL(/[?&]recordDirection=/);
	await expect.poll(() => received.at(-1)?.get('direction')).toBe('0');
});

test('one line picker focuses a single line and adds more lines without leaving that focus active', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.route('**/api/schedule-edition?city=stm', (route) =>
		route.fulfill({
			json: {
				schedule: {
					date: '2026-11-21',
					routes: providers[0].lines,
					stops: [],
					route_directions: {},
				},
			},
		}),
	);
	await page.goto('/map?provider=stm');
	await openMapControls(page);
	await page.locator('[data-map-filter-trigger]').click();
	const picker = page.getByRole('button', { name: 'Add a line filter', exact: true });
	await expect(picker).toHaveCount(1);
	await picker.click();
	await page.getByRole('option', { name: /^24\b/u }).click();
	await expect(page).toHaveURL(/[?&]line=24(?:&|$)/);
	await picker.click();
	await page.getByRole('option', { name: /^51\b/u }).click();
	await expect.poll(() => new URL(page.url()).searchParams.get('route')).toBe('24,51');
	await expect(page).not.toHaveURL(/[?&]line=/);
});
