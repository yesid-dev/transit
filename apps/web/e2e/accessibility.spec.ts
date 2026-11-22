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

const fixture = (name: string) =>
	JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'));
const departures = fixture('departures.json');
const trips = fixture('trips.json').trips;
const tripId = Object.keys(trips)[0];
const lineId = fixture('routes-index.json').routes[0].id;
const line = fixture('../scripts/__fixtures__/b9/rich.json').files[`static/routes/${lineId}.json`];
const lineStopCount = line.directions.reduce(
	(count: number, direction: { stops: unknown[] }) => count + direction.stops.length,
	0,
);
const pages = [
	'/',
	...[...SURFACE_NAV, ...AUDIT_NAV].map(({ href }) => href),
	...FOOTER_INFO_NAV.map(({ href }) => href),
	`/stop/${Object.keys(departures.stops)[0]}`,
	`/lines/${lineId}`,
	`/lines/${lineId}?tab=detail`,
	`/trip/${tripId}`,
	'/trip/TEmpty',
	`/search?q=${encodeURIComponent(fixture('stops-index.json').stops[0].name)}`,
];
const localized = (href: string, locale: Locale) =>
	locale === DEFAULT_LOCALE ? href : `/${locale}${href === '/' ? '' : href}`;

test.use({ bypassCSP: true });

test.beforeEach(async ({ page }) => {
	await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
	// Inside the live data's freshness window, as data-surfaces.spec does.
	await page.clock.setFixedTime(Date.parse(departures.generated_utc) + 30_000);
});

test.describe('accessibility', { tag: '@theme' }, () => {
	for (const locale of PUBLISHED_LOCALES) {
		for (const path of pages) {
			const url = localized(path, locale);
			test(`${url} has no serious or critical axe violations`, async ({ page }) => {
				const lineLive = path === `/lines/${line.id}?tab=detail`;
				if (lineLive) {
					// Give each published stop a report so every destination's visible links reach axe.
					const stops = [
						...new Set<string>(
							line.directions.flatMap((direction: { stops: { id: string }[] }) =>
								direction.stops.map((stop) => stop.id),
							),
						),
					];
					await page.route(/\/v1\/stm\/live\/trips\.json(?:\?|$)/, async (route) => {
						const response = await route.fetch();
						const body = await response.json();
						await route.fulfill({
							response,
							json: {
								...body,
								generated_utc: departures.generated_utc,
								feed_captured_utc: departures.generated_utc,
								trips: {
									...body.trips,
									'a11y-line-predictions': {
										route: lineId,
										status: 'on_time',
										stops: stops.map((stop) => ({
											stop,
											eta_utc: new Date(
												Date.parse(departures.generated_utc) + 300_000,
											).toISOString(),
											delay_min: 0,
										})),
									},
								},
							},
						});
					});
				}
				// As in the layout audit below, scan after client-side fixture data settles.
				await page.goto(
					lineLive || path.startsWith('/trip/') ? localizeHref(path, locale, 'stm') : url,
					{
						waitUntil: 'networkidle',
					},
				);
				await expect(page.getByRole('main')).toBeVisible();
				if (lineLive) {
					const pane = page.locator('[data-slot="line-directions"][data-mode="live"]');
					const destination = pane.getByRole('combobox');
					await expect(destination).toBeVisible();
					await expect(destination.getByRole('option')).toHaveCount(line.directions.length);
					let scanned = 0;
					for (const [index, direction] of line.directions.entries()) {
						await destination.selectOption(String(index));
						const links = pane.getByRole('table').getByRole('rowheader').getByRole('link');
						await expect(links).toHaveCount(direction.stops.length);
						// Axe's label-in-name check needs the selected destination's links on screen.
						for (const link of await links.all()) {
							await link.scrollIntoViewIfNeeded();
							await link.evaluate(
								(element, index) => element.setAttribute('data-axe-stop', String(index)),
								scanned,
							);
							await expectAccessible(page, { include: `[data-axe-stop="${scanned}"]` });
							scanned += 1;
						}
					}
					expect(scanned).toBe(lineStopCount);
				}
				if (path === `/trip/${tripId}`) {
					const count = trips[tripId].stops.length;
					const table = page.getByRole('table', {
						name: tripCopy[locale].reportedPredictions,
						exact: true,
					});
					await expect(table.getByRole('rowheader')).toHaveCount(Math.min(6, count));
					if (count > 6)
						await page
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
				if (path === '/trip/TEmpty') {
					await expect(
						page
							.getByTestId('trip-no-stops')
							.getByText(tripCopy[locale].noPredictions, { exact: true }),
					).toBeVisible();
					await expect(page.locator('.trip-stop-link')).toHaveCount(0);
				}
				await expectAccessible(page);
				if (path === '/metrics') {
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
			test(`${locale}: the ${name} keeps its whole names and 44 px controls`, async ({ page }) => {
				await page.setViewportSize({ width: 320, height: 900 });
				// This project's storage state selects OC Transpo, whose fixture serves no index; the
				// directory case runs against the STM fixtures the other listing cases use.
				await page.goto(localizeHref(path, locale, 'stm'), { waitUntil: 'networkidle' });
				const rows = page.locator('[data-slot="entity-result-row"]');
				await expect(rows.first()).toBeVisible();
				// Every published name stays whole at the narrowest width: no clipped or shredded word.
				const clipped = await rows.evaluateAll((elements) => {
					const problems: string[] = [];
					for (const element of elements) {
						for (const name of element.querySelectorAll('.readable-name')) {
							if (name.scrollWidth > name.clientWidth + 1) problems.push(name.textContent ?? '');
							if (getComputedStyle(name).wordBreak === 'break-all') problems.push('break-all');
						}
					}
					return problems;
				});
				expect(clipped).toEqual([]);
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
			await page.goto(path.startsWith('/trip/') ? localizeHref(path, locale, 'stm') : url, {
				waitUntil: 'networkidle',
			});
			await page.keyboard.press('Tab');
			await expect(page.locator(':focus')).toHaveAttribute('href', '#main');
			await expect(page.locator(':focus')).toHaveAccessibleName(navPillCopy[locale].skipToContent);
			await page.keyboard.press('Enter');
			await expect(page.getByRole('main')).toBeFocused();
			await page.keyboard.press('Tab');
			await expect(page.getByRole('main').locator(':focus')).toHaveCount(1);
			await expect(page.getByRole('banner')).toHaveCount(1);
			await expect(page.getByRole('main')).toHaveAttribute('id', 'main');
			// The map is full-bleed and has no footer.
			await expect(page.getByRole('contentinfo')).toHaveCount(path === '/map' ? 0 : 1);
			await expectNoHorizontalOverflow(page, ['#main-flow']);
			await expectTapTargets(page, { exclude: TAP_EXEMPT });
		});
	}
}
