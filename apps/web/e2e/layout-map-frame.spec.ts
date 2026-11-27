import { expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { test } from './layout-test';
import { mapChromeShareBudget, mapOpenLegendViewportHeight } from './design-pass-debt';
import { captureFixture, captureUrl, captureVehicle } from './capture-fixture';
import { textDefects } from './layout-helpers';
import { closeMapControls, openMapControls, openMapLegend } from './map-frame-controls';
import { expectRampLightness } from './measure-ramp-checks';
import { copy as mapCopy } from '../src/lib/features/map/map.copy';

const lookupStop = JSON.parse(readFileSync(new URL('./stops-index.json', import.meta.url), 'utf8'))
	.stops[0];

for (const locale of ['en', 'fr']) {
	test(`${locale} map chrome leaves room for the map and text enlargement @layout`, async ({
		page,
	}, info) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.clock.setFixedTime(Date.parse('2026-06-15T12:00:20Z'));
		await page.goto(`${locale === 'fr' ? '/fr' : ''}/map?provider=stm`);
		await expect(page.getByTestId('map-progressive')).toHaveAttribute(
			'data-map-progressive-state',
			'ready',
		);
		await expect(page.locator('h1')).toHaveCount(1);
		const measure = () =>
			page.evaluate(() => {
				const selectors = [
					'[data-slot="map-live-chip"]',
					'[data-slot="map-mobile-peek"]',
					'.map-camera-actions',
					'[data-slot="surface-rail-mobile"] button',
					'[data-slot="map-legend-fab"] button',
				];
				const map = document.querySelector('[data-slot="map-frame"]')!.getBoundingClientRect();
				const boxes = selectors.flatMap((selector) =>
					[...document.querySelectorAll<HTMLElement>(selector)].flatMap((element) => {
						const { left, right, top, bottom, width, height } = element.getBoundingClientRect();
						return width && height
							? [
									{
										left,
										right,
										top,
										bottom,
										width,
										height,
										selector,
										clipped: element.scrollWidth > element.clientWidth + 1,
									},
								]
							: [];
					}),
				);
				return {
					share:
						boxes.reduce((area, box) => area + box.width * box.height, 0) /
						(map.width * map.height),
					overlap: boxes.some((a, i) =>
						boxes
							.slice(i + 1)
							.some(
								(b) =>
									a.left < b.right - 1 &&
									a.right > b.left + 1 &&
									a.top < b.bottom - 1 &&
									a.bottom > b.top + 1,
							),
					),
					clipped: boxes
						.filter(
							(box) =>
								box.clipped ||
								box.left < 0 ||
								box.right > innerWidth ||
								box.top < 0 ||
								box.bottom > innerHeight + 1,
						)
						.map(({ selector, left, right, top, bottom }) => ({
							selector,
							left,
							right,
							top,
							bottom,
						})),
				};
			});
		expect((await measure()).share).toBeLessThanOrEqual(mapChromeShareBudget);
		for (const [width, height] of [
			[320, 640],
			[390, 844],
		]) {
			await page.setViewportSize({ width, height });
			await expect(page.getByTestId('map-list-button')).toBeVisible();
			await expect(page.locator('[data-slot="map-source-footer"]')).toBeHidden();
			const exposed = await page.evaluate(() => {
				const chrome = [
					...document.querySelectorAll(
						'nav.nav-pill, [data-slot="network-picker"], [data-slot="map-live-chip"], .map-camera-actions button, [data-slot="map-mobile-peek"], .maplibregl-ctrl-attrib-button',
					),
				];
				const covered = chrome.reduce((total, element) => {
					if (getComputedStyle(element).visibility === 'hidden') return total;
					const { width, height } = element.getBoundingClientRect();
					return total + width * height;
				}, 0);
				return 1 - covered / (innerWidth * innerHeight);
			});
			expect(exposed, `${width}×${height} exposed map area`).toBeGreaterThan(0.75);
			await info.attach(`exposed-map-${width}`, {
				body: String(exposed),
				contentType: 'text/plain',
			});
		}
		await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
		await expect.poll(measure).toMatchObject({ overlap: false, clipped: [] });
	});

	test(`${locale} desktop legend fits and explains four delay statuses @layout`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: mapOpenLegendViewportHeight });
		await page.goto(`${locale === 'fr' ? '/fr' : ''}/map?provider=stm`);
		const legend = page.locator('[data-map-legend="desktop"]');
		await expect(legend).toBeVisible();
		const group = legend.getByRole('list', {
			name:
				locale === 'fr'
					? 'Véhicules, selon le retard au dernier signalement'
					: 'Vehicles, by their delay at the last report',
		});
		await expect(group.getByRole('listitem')).toHaveCount(4);
		const geometry = await legend.evaluate((root) => {
			const rows = [...root.querySelectorAll('ul > li')];
			return {
				bottom: root.getBoundingClientRect().bottom,
				track: rows.map((row) => row.lastElementChild!.getBoundingClientRect().left),
				clipped: root.scrollHeight > root.clientHeight + 1,
			};
		});
		expect(geometry.bottom).toBeLessThanOrEqual(mapOpenLegendViewportHeight);
		expect(geometry.clipped).toBe(false);
		expect(new Set(geometry.track).size).toBe(1);
	});

	test(`${locale} phone address lookup shares the map sheet with nearby stops @layout`, async ({
		page,
	}) => {
		test.skip(page.viewportSize()!.width !== 390, 'one phone project per browser and theme');
		const fr = locale === 'fr';
		const t = mapCopy[fr ? 'fr' : 'en'];
		const result = {
			label: '1591 rue Sherbrooke',
			lat: lookupStop.lat,
			lon: lookupStop.lon,
			precision: 'address',
			source: 'geo_ca',
		};
		await page.route('**/api/geocode**', (route) => {
			const query = new URL(route.request().url()).searchParams;
			if (query.get('q') === 'Sherbrooke') return route.fulfill({ json: { results: [result] } });
			return route.fulfill({ status: 404, json: { error: 'place_not_found' } });
		});
		await page.goto(`${fr ? '/fr' : ''}/map?provider=stm&lookup=address`);
		await expect(page.getByTestId('map-progressive')).toHaveAttribute(
			'data-map-progressive-state',
			'ready',
		);
		const sheet = page.locator('[data-map-in-view-sheet]');
		const address = sheet.getByRole('combobox', { name: t.nearMeAddressLabel });
		await expect(address).toBeVisible();
		expect((await address.boundingBox())!.width).toBeGreaterThanOrEqual(280);
		await address.fill('Somewhere else');
		await sheet.getByRole('button', { name: t.nearMeSearchSubmit, exact: true }).click();
		await expect(
			sheet.getByRole('status').filter({ hasText: t.nearMeNotFound('Somewhere else') }),
		).toBeVisible();
		await address.fill('Sherbrooke');
		const option = sheet.getByRole('option', { name: /1591 rue Sherbrooke/ });
		await expect(option).toBeVisible();
		await address.press('ArrowDown');
		await expect(option).toHaveAttribute('aria-selected', 'true');
		await address.press('Enter');
		const nearby = sheet.locator('[data-slot="map-nearby-stops"]');
		await expect(nearby.getByRole('heading')).toContainText(result.label);
		await expect(nearby.locator('[data-map-row-name]').first()).toBeVisible();
		await expect(sheet).toHaveAttribute('data-map-sheet-mode', 'nearby');
		const rows = await nearby.locator('[data-map-panel-row]').evaluateAll((elements) =>
			elements.map((row) => ({
				nameX: row.querySelector('[data-map-row-name]')!.getBoundingClientRect().left,
				codeX: row.querySelector('[data-map-row-code]')!.getBoundingClientRect().left,
				valueRight: row.querySelector('[data-map-row-value]')!.getBoundingClientRect().right,
			})),
		);
		for (const row of rows) expect(row).toEqual(rows[0]);
		await nearby.getByRole('button', { name: t.nearMeClear }).click();
		await expect(nearby).toBeHidden();
	});

	test(`${locale} crowding legend orders the five levels under their swatches @layout`, async ({
		page,
	}, info) => {
		const fr = locale === 'fr';
		const phone = page.viewportSize()!.width < 1024;
		const at = Date.parse('2026-11-23T16:00:00Z');
		await page.clock.setFixedTime(at);
		await page.route(captureUrl, (route) =>
			route.fulfill({
				json: captureFixture(at, { vehicle_positions: [captureVehicle(at, { occupancy: 0 })] }),
			}),
		);
		await page.goto(`${fr ? '/fr' : ''}/map?provider=stm`);
		await openMapControls(page);
		await page.locator('[data-map-filter-trigger]').click();
		const crowding = page.locator('[data-filter-group="crowding"]');
		await crowding.getByRole('checkbox', { name: fr ? 'Vide' : 'Empty', exact: true }).click();
		await closeMapControls(page);
		if (phone) await openMapLegend(page);
		const legendSelector = `[data-map-legend="${phone ? 'phone' : 'desktop'}"]`;
		const legend = page.locator(legendSelector);
		const ramp = legend.getByRole('list', { name: fr ? 'Places à bord' : 'Room on board' });
		await expect(ramp).toBeVisible();
		await expect(ramp.getByRole('listitem')).toHaveText(
			fr
				? ['Vide', 'Plusieurs places', 'Peu de places', 'Debout', 'Plein']
				: ['Empty', 'Many seats', 'Few seats', 'Standing', 'Full'],
		);
		await expectRampLightness(
			ramp.locator('li > [aria-hidden="true"]'),
			info.project.use.colorScheme === 'dark' ? 'dark' : 'light',
		);
		const viewport = page.viewportSize()!;
		for (const width of viewport.width === 390 ? [320, 390] : [viewport.width]) {
			await page.setViewportSize({ width, height: viewport.height });
			await expect(ramp).toBeVisible();
			if (fr) await expect(ramp.getByText('Plusieurs places', { exact: true })).toBeVisible();
			const defects = await textDefects(page, legendSelector);
			expect(
				defects.filter(({ kind }) => kind === 'broken-word'),
				`${width}px legend`,
			).toEqual([]);
			const overflow = await ramp.evaluate((list) => list.scrollWidth - list.clientWidth);
			expect(overflow, `${width}px legend horizontal overflow`).toBeLessThanOrEqual(1);
		}
	});
}
