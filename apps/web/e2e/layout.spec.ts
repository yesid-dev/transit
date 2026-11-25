import { test } from './layout-test';
import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import { chartOverlaps, forwardRoute } from './layout-helpers';
import { expectLayout } from './layout-debt';
import { localizeHref } from '../src/lib/i18n/routing';
import {
	captureFixture,
	captureTrip,
	captureTripReport,
	captureUrl,
	captureVehicle,
	layoutCapture,
} from './capture-fixture';

const fixture = (name: string) =>
	JSON.parse(readFileSync(new URL(`./${name}.json`, import.meta.url), 'utf8'));
const epoch = Date.parse(fixture('departures').generated_utc);
const line = fixture('routes-index').routes[0].id;
const stop = Object.keys(fixture('departures').stops)[0];
const pages = [
	'/',
	'/map?provider=stm&vehicle=layout-bus',
	'/lines',
	'/stops',
	'/stops?q=Fixture',
	`/stops?route=${line}`,
	`/lines/${line}`,
	`/lines/${line}?tab=detail`,
	`/stop/${stop}`,
	`/stop/${stop}?tab=detail`,
	'/network',
	'/hotspots',
	'/repeat-offenders',
	'/alerts',
	'/receipt',
	'/receipt?date=2026-08-30',
	'/status',
	'/vehicle/40061?frameMode=live',
	`/search?q=${encodeURIComponent(fixture('stops-index').stops[0].name)}`,
];

for (const locale of ['en', 'fr'] as const)
	for (const state of ['fresh', 'stale', 'missing']) {
		for (const path of pages)
			test(`${locale} ${state} ${path} @layout`, async ({ page }, info) => {
				await page.clock.setFixedTime(epoch + (state === 'stale' ? 900_000 : 30_000));
				await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
				await page.route('**/v1/**', (route) =>
					forwardRoute(page, async () => {
						const url = new URL(route.request().url());
						url.pathname = `/__layout/${state}${url.pathname}`;
						await route.fulfill({ response: await route.fetch({ url: url.href }) });
					}),
				);
				if (state === 'missing')
					await page.route(captureUrl, (route) =>
						route.fulfill({
							json: layoutCapture(new URL(route.request().url()).searchParams.get('city')!, {
								delay: null,
								occupancy: null,
								speed_mps: null,
								stop_id: null,
							}),
						}),
					);
				const href = path === '/status' ? '/status?frameMode=live' : path;
				await page.goto(localizeHref(href, locale), { waitUntil: 'networkidle' });
				if (path.startsWith('/stops?q='))
					await page.getByTestId('stops-filter-input').fill('Fixture');
				// Measure Data health's detail for auditors, which starts closed.
				const details = page.locator('[data-toc="health-details"] [data-section-trigger]').first();
				if (path === '/status' && (await details.count())) {
					await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
					await details.click();
					await expect(details).toHaveAttribute('aria-expanded', 'true');
				}
				await expect(page.getByRole('main')).toBeVisible();
				await page.evaluate(() => document.fonts.ready);
				await page.waitForTimeout(250);
				if (path.startsWith('/receipt')) {
					const report = page.locator('article.daily-report');
					await expect(report.getByRole('heading', { level: 1 })).toBeVisible();
					if (path.includes('date=')) {
						await expect(report.getByRole('status')).toContainText(
							locale === 'fr' ? 'hors du bilan disponible' : 'outside the available record',
						);
					} else await expect(report.locator('#punctuality')).toBeVisible();
				}
				if (path.startsWith('/map')) {
					const canvas = page.locator('[data-slot="vehicle-overlay"]');
					await expect
						.poll(() =>
							canvas.evaluate(
								(el) =>
									Reflect.get(el, Symbol.for('transit.map.vehicleOverlayReceipt'))
										?.paintedBodyCount ?? 0,
							),
						)
						.toBeGreaterThan(0);
					const point = await page.evaluate(() =>
						(
							window as unknown as {
								__transitMap: { project(c: [number, number]): { x: number; y: number } };
							}
						).__transitMap.project([-73.59, 45.51]),
					);
					await page.locator('.maplibregl-canvas').click({ position: point });
					const detail = page.locator('[data-slot="map-detail-overlay"]');
					await expect(detail).toBeVisible();
					if (state === 'stale')
						await expect(page.locator('[data-slot="map-feed-stall"]')).toBeVisible();
					if (state === 'missing')
						await expect(
							detail.locator('[data-slot="status-mark"][data-status="unknown"]'),
						).toBeVisible();
				}
				if (state === 'fresh' && path === `/lines/${line}` && page.viewportSize()!.width < 1024) {
					// The Record heading starts below the actual frame controls.
					const pill = await page.locator('[data-slot="app-frame-header"]').boundingBox();
					const heading = page.getByRole('main').getByRole('heading', { level: 1 });
					expect(pill!.y + pill!.height).toBeLessThanOrEqual(
						(await heading.first().boundingBox())!.y,
					);
				}
				const overlaps = path === '/network' ? await chartOverlaps(page) : [];
				await expectLayout(page, info, overlaps);
			});
	}

for (const locale of ['en', 'fr'] as const)
	for (const provider of ['stm', 'octranspo'])
		test(`${locale} ${provider} trip long names stay readable @layout`, async ({ page }) => {
			const name =
				'Station Université de Montréal / Boulevard Édouard-Montpetit et chemin de la Côte-des-Neiges / Terminus des voyageurs';
			await page.clock.setFixedTime(epoch + 30_000);
			await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
			await page.route(captureUrl, (route) =>
				route.fulfill({
					json: captureFixture(epoch, {
						city: provider,
						vehicle_positions: [captureVehicle(epoch)],
					}),
				}),
			);
			await page.route(`**/api/live-trips?city=${provider}&trip=T1`, (route) =>
				route.fulfill({
					json: captureTripReport(provider, new Date(epoch).toISOString(), [
						captureTrip('T1', '24', [
							{ stop: 'S1', eta_utc: new Date(epoch + 180_000).toISOString(), delay_min: 4 },
						]),
					]),
				}),
			);
			await page.route(`**/api/stops/slim?provider=${provider}`, async (route) => {
				const response = await route.fetch();
				const body = await response.json();
				for (const stop of body.stops) stop.name = name;
				await route.fulfill({ response, json: body });
			});
			await page.goto(localizeHref(`/vehicle/40061?frameMode=live&provider=${provider}`, locale), {
				waitUntil: 'networkidle',
			});
			await page
				.getByRole('button', { name: locale === 'fr' ? 'Voir les prévisions' : 'View predictions' })
				.click();
			const link = page.locator('.trip-stop-link').first();
			await expect(link).toHaveAccessibleName(new RegExp(name.split(' / ')[0]));
			await expect(link.locator('[title]')).toHaveAttribute('title', name);
			const geometry = await link.evaluate((el) => {
				const row = el.closest('tr')!;
				const name = el.querySelector('.trip-stop-name')!;
				const time = row.querySelector('time')!;
				const nr = name.getBoundingClientRect(),
					tr = time.getBoundingClientRect(),
					lr = el.getBoundingClientRect();
				return {
					clipped:
						name.scrollHeight > name.clientHeight + 1 || name.scrollWidth > name.clientWidth + 1,
					nameTop: nr.top,
					nameBottom: nr.bottom,
					nameRight: nr.right,
					timeTop: tr.top,
					timeBottom: tr.bottom,
					timeLeft: tr.left,
					linkHeight: lr.height,
				};
			});
			expect(geometry.clipped).toBe(false);
			expect(geometry.linkHeight).toBeGreaterThanOrEqual(44);
			if (page.viewportSize()!.width >= 1024) {
				expect(geometry.nameRight).toBeLessThanOrEqual(geometry.timeLeft);
				expect(geometry.timeTop).toBeLessThan(geometry.nameBottom);
				expect(geometry.timeBottom).toBeGreaterThan(geometry.nameTop);
			} else expect(geometry.timeTop).toBeGreaterThanOrEqual(geometry.nameBottom);
			expect(await page.locator('html').evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(
				page.viewportSize()!.width,
			);
		});

for (const locale of ['en', 'fr'] as const)
	for (const provider of fixture('providers').providers)
		test(`${locale} ${provider.id} header provider stays readable @layout`, async ({ page }) => {
			await page.clock.setFixedTime(epoch + 30_000);
			await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
			await page.route('**/v1/**', (route) =>
				forwardRoute(page, async () => {
					const url = new URL(route.request().url());
					url.pathname = `/__layout/fresh${url.pathname.replace('/octranspo/', '/stm/')}`;
					await route.fulfill({ response: await route.fetch({ url: url.href }) });
				}),
			);
			await page.goto(localizeHref(`/?provider=${provider.id}`, locale), {
				waitUntil: 'networkidle',
			});
			await page.evaluate(() => document.fonts.ready);
			const header = page.locator('[data-slot="app-frame-header"]');
			const { city, operator } = provider.labels[locale];
			const fullName = `${city} · ${operator}`;
			const network = header.locator('[data-slot="network-picker"]');
			const picker = network.getByRole('combobox');
			const label = network.locator('span[aria-hidden="true"]:visible');
			await expect(picker).toHaveAccessibleName(new RegExp(fullName));
			await expect(network).toHaveAttribute('title', fullName);
			await expect(picker.locator('option:checked')).toHaveText(fullName);
			const viewport = page.viewportSize()!;
			// Exercise both phone widths in each light/dark phone project.
			for (const width of viewport.width < 600 ? [360, 390] : [viewport.width]) {
				await page.setViewportSize({ ...viewport, width });
				await expect(label).toBeVisible();
				await expect(label).toHaveText(width < 1024 ? operator : fullName);
				await expect
					.poll(() => label.evaluate((el) => el.scrollWidth - el.clientWidth))
					.toBeLessThanOrEqual(0);
			}
		});
