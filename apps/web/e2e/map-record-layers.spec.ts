import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';
import {
	closeMapInView,
	openMapControls,
	openMapInView,
	openMapLegend,
} from './map-frame-controls';

const providers = [
	{
		id: 'stm',
		stops: [
			['Mont-Royal', 45.512, -73.569],
			['Laurier', 45.522, -73.581],
			['Rosemont', 45.533, -73.594],
			['Beaubien', 45.544, -73.607],
		],
	},
	{
		id: 'octranspo',
		stops: [
			['Rideau', 45.428, -75.692],
			['Mackenzie King', 45.424, -75.689],
			['Laurier', 45.42, -75.682],
			['uOttawa', 45.416, -75.681],
		],
	},
] as const;

async function setup(page: Page, provider: (typeof providers)[number]) {
	await page.route(`**/api/stops/slim?provider=${provider.id}`, (route) =>
		route.fulfill({
			json: {
				generated_utc: '2026-11-21T00:00:00Z',
				stops: provider.stops.map(([name, lat, lon], index) => ({
					id: `K1-${'ABCD'[index]}`,
					name,
					lat,
					lon,
					routes: ['24', '51'],
				})),
			},
		}),
	);
}

test('applies the shared Record filters when switching readings with the keyboard', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await setup(page, providers[0]);
	const readingResponse = (layer: string) =>
		page.waitForResponse((response) => {
			const url = new URL(response.url());
			return url.pathname === '/api/map-record' && url.searchParams.get('layer') === layer;
		});
	const clear = readingResponse('clear-run');
	await page.goto(
		`/map?provider=stm&${period}&mapLayer=clear-run&route=24,51&vehicleType=3&timeOfDay=22-6&mapDirection=0`,
	);
	const assertScope = (url: string) => {
		const params = new URL(url).searchParams;
		expect(Object.fromEntries(params)).toMatchObject({
			from: '2026-11-18',
			to: '2026-11-21',
			lines: '["24","51"]',
			direction: '0',
			route_type: '3',
			hour_from: '22',
			hour_to: '6',
		});
	};
	const clearResponse = await clear;
	expect(clearResponse.ok()).toBe(true);
	assertScope(clearResponse.url());
	await openMapControls(page);
	await expect(
		page.getByRole('region', { name: 'Time lost by stretch' }).getByRole('listitem'),
	).toHaveCount(3);
	const wait = readingResponse('waits');
	await page.getByRole('radio', { name: 'Clear run' }).press('ArrowRight');
	await expect(page.getByRole('radio', { name: 'Waits', exact: true })).toBeFocused();
	await expect(page.getByRole('radio', { name: 'Waits', exact: true })).toBeChecked();
	await expect(page).toHaveURL(/[?&]mapLayer=waits\b/);
	const waitResponse = await wait;
	expect(waitResponse.ok()).toBe(true);
	assertScope(waitResponse.url());
	await expect(
		page.getByRole('region', { name: 'Waits by stop and line' }).getByRole('listitem'),
	).toHaveCount(4);
});

function recordMarks(page: Page): Promise<{ id: string; step: number }[]> {
	return page.locator('[data-map-runtime]').evaluate((root) => {
		const inspect = Reflect.get(root, Symbol.for('transit.map.renderReceipt'));
		return typeof inspect === 'function' ? inspect().recordMarks : [];
	});
}

const period = 'frameMode=record&recordFrom=2026-11-18&recordTo=2026-11-21';

for (const provider of providers) {
	for (const locale of ['en', 'fr']) {
		for (const layer of ['clear-run', 'waits']) {
			test(`${provider.id} ${locale} maps and lists ${layer} readings @theme`, async ({
				page,
			}, info) => {
				const fr = locale === 'fr';
				const waits = layer === 'waits';
				const listName = waits
					? fr
						? 'Attentes par arrêt et par ligne'
						: 'Waits by stop and line'
					: fr
						? 'Temps perdu par tronçon'
						: 'Time lost by stretch';
				const legendName = waits
					? fr
						? 'Attente en plus à chaque arrêt'
						: 'Extra wait at each stop'
					: fr
						? 'Temps perdu par rapport au parcours fluide'
						: 'Time lost against the clear run';
				await setup(page, provider);

				for (const width of [390, 1440]) {
					const phone = width === 390;
					await page.setViewportSize({ width, height: phone ? 844 : 900 });
					const readingResponse = page.waitForResponse(
						(response) =>
							response.url().includes(`/api/map-record?`) &&
							new URL(response.url()).searchParams.get('layer') === layer,
					);
					await page.goto(
						`${fr ? '/fr' : ''}/map?provider=${provider.id}&${period}&mapLayer=${layer}`,
					);
					expect((await readingResponse).ok()).toBe(true);
					await openMapInView(page);

					const list = page.getByRole('region', { name: listName });
					const rows = list.getByRole('listitem');
					await expect(rows).toHaveCount(waits ? 5 : 4);
					await expect(rows.first()).toContainText(waits ? /1[.,]5\s+min/u : /1[.,]6\s+min/u);
					const id = waits ? '["51",0,"K1-A"]' : '["51",0,"K1-B","K1-C"]';
					await expect
						.poll(() => recordMarks(page))
						.toContainEqual(
							expect.objectContaining({
								id,
								step: waits ? 2 : 3,
							}),
						);
					if (waits) {
						const stopRows = rows.filter({ hasText: provider.stops[0][0] });
						await expect(stopRows).toHaveCount(2);
						await expect(stopRows.first().getByRole('link')).toHaveAccessibleName(
							fr ? /ligne 51\b/u : /line 51\b/u,
						);
						await expect(stopRows.last().getByRole('link')).toHaveAccessibleName(
							fr ? /ligne 24\b/u : /line 24\b/u,
						);
						await expect(stopRows.last()).toContainText(/-8\s+s/u);
						expect((await recordMarks(page)).some((mark) => mark.id === '["24",0,"K1-A"]')).toBe(
							false,
						);
					}

					const evidence = process.env.TRANSIT_K1_PICTURES;
					if (evidence)
						await page.screenshot({
							path: join(
								evidence,
								`${layer}-${provider.id}-${locale}-${width}-${info.project.name}.png`,
							),
							animations: 'disabled',
						});
					await rows.first().getByRole('link').press('Enter');
					const selection = page.locator('[data-slot="record-map-selection"]');
					await expect(selection).toContainText(waits ? /1[.,]5\s+min/u : /1[.,]6\s+min/u);
					if (!waits) {
						await expect(selection).toContainText(fr ? 'Trajet médian' : 'Median trip');
						await expect(selection).toContainText(/2[.,]9\s+min/u);
					}

					if (phone) await openMapLegend(page);
					const legend = page.locator(
						phone ? '[data-map-legend="phone"]' : '[data-map-legend="desktop"]',
					);
					await expect(legend.getByText(legendName, { exact: true })).toBeVisible();
					if (phone) await closeMapInView(page);
					await openMapControls(page);
					const clearRun = page.getByRole('radio', { name: fr ? 'Parcours fluide' : 'Clear run' });
					await expect(clearRun).toBeVisible();
					expect(
						await clearRun.evaluate(async (button) => {
							await document.fonts.ready;
							const text = document.createRange();
							text.selectNodeContents(button);
							return new Set([...text.getClientRects()].map(({ top }) => top)).size;
						}),
					).toBe(1);
					await expect(
						page.getByRole('radio', {
							name: waits ? (fr ? 'Attentes' : 'Waits') : fr ? 'Parcours fluide' : 'Clear run',
						}),
					).toBeChecked();
					if (phone) await closeMapInView(page);
				}
			});
		}
	}
}
