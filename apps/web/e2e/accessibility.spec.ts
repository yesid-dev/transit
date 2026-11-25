import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
	expectAccessible,
	expectNoHorizontalOverflow,
	expectTapTargets,
} from '@yesid/config/playwright';

import { navPillCopy } from '../src/lib/i18n/messages';
import { headerSearchCopy } from '../src/lib/components/shell/headerSearch.copy';
import { AUDIT_NAV, FOOTER_INFO_NAV, SURFACE_NAV } from '../src/lib/content/nav';
import { DEFAULT_LOCALE, PUBLISHED_LOCALES, type Locale } from '../src/lib/i18n/config';
import { localizeHref } from '../src/lib/i18n/routing';
import { tripCopy } from '../src/lib/features/trips/trips.copy';
import {
	captureFixture,
	captureTrip,
	captureTripReport,
	captureUrl,
	captureVehicle,
} from './capture-fixture';

const fixture = (name: string) =>
	JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'));
const departures = fixture('departures.json');
const trips = fixture('trips.json').trips;
const tripId = 'T1';
const lineId = fixture('routes-index.json').routes[0].id;
const line = fixture('../scripts/__fixtures__/b9/rich.json').files[`static/routes/${lineId}.json`];
const lineStops = [
	...new Set<string>(
		line.directions.flatMap((direction: { stops: { id: string }[] }) =>
			direction.stops.map((stop) => stop.id),
		),
	),
];
const readerTime = Date.parse(departures.generated_utc) + 30_000;
const pages = [
	'/',
	...[...SURFACE_NAV, ...AUDIT_NAV].map(({ href }) => href),
	...FOOTER_INFO_NAV.map(({ href }) => href),
	'/metrics/archive',
	'/network?frameMode=record&recordFrom=2026-11-20&recordTo=2026-11-22',
	`/stop/${Object.keys(departures.stops)[0]}`,
	`/lines/${lineId}`,
	`/lines/${lineId}?tab=detail`,
	`/vehicle/40061?frameMode=live`,
	`/search?q=${encodeURIComponent(fixture('stops-index.json').stops[0].name)}`,
];
const localized = (href: string, locale: Locale) =>
	locale === DEFAULT_LOCALE ? href : `/${locale}${href === '/' ? '' : href}`;

test.use({ bypassCSP: true });

test.beforeEach(async ({ page }) => {
	await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
	// Inside the live data's freshness window, as data-surfaces.spec does.
	await page.clock.install({ time: readerTime });
	await page.clock.setFixedTime(readerTime);
});

test.describe('accessibility', { tag: '@theme' }, () => {
	for (const locale of PUBLISHED_LOCALES) {
		for (const path of pages) {
			const url = localized(path, locale);
			test(`${url} has no serious or critical axe violations`, async ({ page }) => {
				const lineLive = path === `/lines/${line.id}?tab=detail`;
				const vehicleLive = path === '/vehicle/40061?frameMode=live';
				if (lineLive) {
					await page.route(captureUrl, (route) =>
						route.fulfill({
							json: captureFixture(readerTime, {
								vehicle_positions: [
									captureVehicle(readerTime, { route_id: lineId, stop_id: lineStops[0] }),
								],
							}),
						}),
					);
					const eta_utc = new Date(readerTime + 300_000).toISOString();
					await page.route(`**/api/live-trips?city=stm&line=${lineId}`, (route) =>
						route.fulfill({
							json: captureTripReport('stm', new Date(readerTime).toISOString(), [
								captureTrip(
									'a11y-line-predictions',
									lineId,
									lineStops.map((stop) => ({ stop, eta_utc, delay_min: 0 })),
								),
							]),
						}),
					);
				}
				if (vehicleLive) {
					// The Vehicle page needs a current assignment and its scoped prediction report.
					// Match the timestamps to the frozen reader clock used by this audit.
					const timestamp = departures.generated_utc;
					const at = Date.parse(timestamp);
					const trip = trips[tripId];
					await page.route(captureUrl, (route) =>
						route.fulfill({
							json: captureFixture(at, {
								vehicle_positions: [captureVehicle(at, { trip_id: tripId, route_id: trip.route })],
							}),
						}),
					);
					await page.route(`**/api/live-trips?city=stm&trip=${tripId}`, (route) =>
						route.fulfill({
							json: captureTripReport('stm', timestamp, [
								captureTrip(tripId, trip.route, trip.stops),
							]),
						}),
					);
				}
				// As in the layout audit below, scan after client-side fixture data settles.
				await page.goto(lineLive || vehicleLive ? localizeHref(path, locale, 'stm') : url, {
					waitUntil: 'networkidle',
				});
				await expect(page.getByRole('main')).toBeVisible();
				if (lineLive) {
					await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
					const refresh = page.waitForResponse((response) => captureUrl.test(response.url()));
					await page.clock.fastForward(21_000);
					await refresh;
					const roster = page.locator('#line-detail-live');
					await expect(roster.locator('tbody tr')).toHaveCount(1);
					await expect(roster.getByRole('link')).toHaveCount(2);
					const predictions = page.locator('#line-detail-directions');
					await expect(predictions).toContainText(locale === 'fr' ? 'dans 5 min' : 'in 5 min');
					const links = roster.or(predictions).getByRole('link');
					for (const [index, link] of (await links.all()).entries()) {
						await link.scrollIntoViewIfNeeded();
						await link.evaluate(
							(element, index) => element.setAttribute('data-axe-line-link', String(index)),
							index,
						);
						await expectAccessible(page, { include: `[data-axe-line-link="${index}"]` });
					}
				}
				if (vehicleLive) {
					const count = trips[tripId].stops.length;
					const name = tripCopy[locale].reportedPredictions;
					const inline = page.getByRole('main').getByRole('table', { name, exact: true });
					await expect(inline.getByRole('rowheader')).toHaveCount(Math.min(3, count));
					await expectAccessible(page, { include: 'main' });
					await page
						.getByRole('button', {
							name: locale === 'fr' ? 'Voir les prévisions' : 'View predictions',
						})
						.click();
					const sheet = page.getByRole('dialog');
					const table = sheet.getByRole('table', { name, exact: true });
					await expect(table.getByRole('rowheader')).toHaveCount(Math.min(6, count));
					if (count > 6)
						await sheet
							.getByRole('button', { name: tripCopy[locale].showAll(count), exact: true })
							.click();
					const rows = table.locator('tbody tr');
					await expect(rows).toHaveCount(count);
					for (const [index, row] of (await rows.all()).entries()) {
						await row.scrollIntoViewIfNeeded();
						await row.evaluate(
							(element, index) => element.setAttribute('data-axe-trip-row', String(index)),
							index,
						);
						await expectAccessible(page, { include: `[data-axe-trip-row="${index}"]` });
					}
				}
				await expectAccessible(page);
				if (path === '/metrics/archive') {
					// The former inner scroller clipped these badges out of the initial axe scan.
					for (const kind of ['not-really', 'caveat']) {
						const badge = page
							.locator(`[data-kind="${kind}"] [data-slot="typed-information-badge"]`)
							.first();
						await badge.scrollIntoViewIfNeeded();
						await badge.evaluate((element) => element.setAttribute('data-axe-badge', ''));
						await expectAccessible(page, { include: '[data-axe-badge]' });
						await badge.evaluate((element) => element.removeAttribute('data-axe-badge'));
					}
				}
			});
		}

		test(`${locale}: the open menu has no serious or critical axe violations`, async ({ page }) => {
			const copy = navPillCopy[locale];
			const menu = page.getByRole('navigation', { name: copy.menu });
			await page.goto(localized(AUDIT_NAV[0].href, locale), { waitUntil: 'networkidle' });
			await expect(async () => {
				if (!(await menu.isVisible()))
					await page.getByRole('button', { name: copy.openMenu }).click();
				await expect(menu).toBeVisible({ timeout: 1000 });
			}).toPass();
			await expectAccessible(page);
		});

		test(`${locale}: the open search sheet has no serious or critical axe violations`, async ({
			page,
		}) => {
			const name = navPillCopy[locale].searchAria.all;
			await page.setViewportSize({ width: 390, height: 844 });
			await page.goto(localized('/', locale), { waitUntil: 'networkidle' });
			await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
			await page.getByRole('button', { name, exact: true }).click();
			const sheet = page.getByRole('dialog', { name: headerSearchCopy[locale].sheetTitle });
			await sheet.getByRole('combobox', { name }).fill(fixture('stops-index.json').stops[0].name);
			await expect(sheet.getByRole('option').first()).toBeVisible();
			await expectAccessible(page);
			await expectTapTargets(page);
		});

		for (const [path, name] of [
			['/lines', 'lines directory'],
			['/stops', 'stops finder'],
		] as const)
			test(`${locale}: the ${name} keeps its whole names and 44 px controls`, async ({
				page,
			}, info) => {
				await page.setViewportSize({ width: 320, height: 900 });
				// This project's storage state selects OC Transpo, whose fixture serves no index; the
				// directory case runs against the STM fixtures the other listing cases use.
				await page.goto(localizeHref(path, locale, 'stm'), { waitUntil: 'networkidle' });
				const rows = page.locator('main table tbody tr');
				await expect(rows.first()).toBeVisible();
				// Every published name stays whole at the narrowest width: no clipped or shredded word.
				const clipped = await rows.evaluateAll((elements) => {
					const problems: string[] = [];
					for (const element of elements) {
						for (const name of element.querySelectorAll('th a')) {
							const parts = name.querySelectorAll('.name-label, .detail');
							for (const text of parts.length ? parts : [name]) {
								if (text.scrollWidth > text.clientWidth + 1) problems.push(text.textContent ?? '');
								if (getComputedStyle(text).wordBreak === 'break-all') problems.push('break-all');
							}
						}
					}
					return problems;
				});
				expect(clipped).toEqual([]);
				if (path === '/lines') {
					const row = rows.filter({ hasText: 'West B9' });
					await expect(row).toBeVisible();
					await row.screenshot({ path: info.outputPath('lines-320-whole-name.png') });
				}
				await expectTapTargets(page);
				await expectNoHorizontalOverflow(page);
				await expectAccessible(page);
			});
	}
});

// MapLibre's own controls; its 24 px attribution toggle meets WCAG 2.5.8's minimum.
const TAP_EXEMPT = ['.maplibregl-ctrl'];

for (const locale of PUBLISHED_LOCALES) {
	for (const path of pages) {
		const url = localized(path, locale);
		test(`${url} keeps the page skeleton, fits the viewport and sizes its targets`, async ({
			page,
		}) => {
			// networkidle: the client-side data lands before the page is measured.
			await page.goto(path.startsWith('/vehicle/') ? localizeHref(path, locale, 'stm') : url, {
				waitUntil: 'networkidle',
			});
			const announcement = page.locator('[data-slot="announcement-banner"]');
			if (await announcement.isVisible()) {
				await page.keyboard.press('Tab');
				await expect(announcement.getByRole('link')).toBeFocused();
				await page.keyboard.press('Tab');
				await expect(announcement.getByRole('button')).toBeFocused();
			}
			await page.keyboard.press('Tab');
			await expect(page.locator(':focus')).toHaveAttribute('href', '#main');
			await expect(page.locator(':focus')).toHaveAccessibleName(navPillCopy[locale].skipToContent);
			await page.keyboard.press('Enter');
			await expect(page.getByRole('main')).toBeFocused();
			await page.keyboard.press('Tab');
			await expect(page.getByRole('main').locator(':focus')).toHaveCount(1);
			await expect(page.getByRole('banner')).toHaveCount(1);
			await expect(page.getByRole('main')).toHaveAttribute('id', 'main');
			const footer = page.getByRole('contentinfo');
			await expect(footer).toHaveCount(1);
			if (path === '/map') {
				await expect(footer).toHaveAttribute('data-slot', 'map-source-footer');
			}
			await expectNoHorizontalOverflow(page, ['#main-flow']);
			await expectTapTargets(page, { exclude: TAP_EXEMPT });
		});
	}
}
