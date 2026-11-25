import { openFrameControls } from './frame-controls';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

import { copy as healthCopy } from '../src/lib/features/health/health.copy';
import { detailCopy } from '../src/lib/features/stops/stops.copy';
import { createLineDirectory } from '../src/lib/site/lineDirectory';
import { routeNameFallback } from '../src/lib/site/nameFallback';
import { tripCopy } from '../src/lib/features/trips/trips.copy';
import { DEFAULT_LOCALE as locale, PUBLISHED_LOCALES } from '../src/lib/i18n/config';
import { localizeHref } from '../src/lib/i18n/routing';
import { stampCopy } from '../src/lib/v1/stamp.copy';
import { waitForFrameClearance } from './layout-helpers';
import {
	captureTrip,
	captureTripReport,
	captureUrl,
	layoutCapture,
	liveTripsUrl,
} from './capture-fixture';

const fixture = (name: string) =>
	JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'));
const departures = fixture('departures.json');
const stop = Object.keys(departures.stops)[0]!;
const trips = fixture('trips.json').trips;
// Inside the live data's 30 s freshness window.
const now = Date.parse(departures.generated_utc) + 30_000;

for (const lang of PUBLISHED_LOCALES)
	test(lang + ': live pages show only the live and record stamp forms', async ({ page }) => {
		const manifest = fixture('manifest.json');
		const line = fixture('routes-index.json').routes[0].id;
		const trip = Object.keys(trips)[0];
		const stopName = fixture('stops-index.json').stops[0].name;
		const patterns = (['data', 'alerts'] as const).flatMap((subject) =>
			(['current', 'behind', 'unknown', 'not-responding'] as const).map((state) =>
				stampCopy[lang].live(subject, state, '\0').split('\0').join('.+'),
			),
		);
		const pattern = new RegExp('^(?:' + patterns.join('|') + ')$');
		let liveCount = 0;
		for (const path of [
			'/',
			'/map',
			'/network',
			'/lines/' + line + '?tab=detail',
			'/stop/' + stop + '?tab=detail',
			'/trip/' + trip,
			'/search?q=' + encodeURIComponent(stopName),
		]) {
			await page.goto(localizeHref(path, lang, manifest.provider));
			await page.waitForLoadState('networkidle');
			const stamps = page.locator('[data-slot="freshness-stamp"]');
			for (const stamp of await stamps.all()) {
				await expect(stamp).toHaveAttribute('data-form', /^(live|record)$/);
				if ((await stamp.getAttribute('data-form')) === 'live') {
					await expect(stamp.locator('time')).not.toHaveCSS('white-space', 'nowrap');
					await expect(stamp.locator('time')).toHaveText(pattern);
					liveCount++;
				}
			}
			if (path === '/network') await expect(page.locator('[data-slot="feed-age"]')).toHaveCount(0);
			if (path === '/network' || path.startsWith('/trip/'))
				await expect(page.locator('[data-slot="article-keywords"]')).toHaveCount(0);
		}
		expect(liveCount).toBeGreaterThan(0);
	});

test.use({ bypassCSP: true });

test.beforeEach(async ({ page }) => {
	await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
	await page.route(captureUrl, (route) =>
		route.fulfill({
			json: layoutCapture(new URL(route.request().url()).searchParams.get('city')!),
		}),
	);
	await page.clock.setFixedTime(now);
});

test('a trip page shows one heading without breadcrumbs', async ({ page }) => {
	const provider = fixture('manifest.json').provider;
	for (const lang of PUBLISHED_LOCALES) {
		const directory = createLineDirectory(fixture('routes-index.json').routes, {
			line: (id) => routeNameFallback(id, lang),
		});
		for (const id of [Object.keys(trips)[0], 'TLine']) {
			const route = trips[id].route;
			const identity = directory.name(route);
			const lineLabel =
				identity.number || identity.name ? identity.spoken : tripCopy[lang].lineId(route);
			const heading = tripCopy[lang].reportTitle;
			await page.goto(localizeHref('/trip/' + id, lang, provider), { waitUntil: 'networkidle' });
			await expect(page.getByRole('navigation', { name: /Breadcrumb|Fil d/ })).toHaveCount(0);
			await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
			await expect(
				page.getByRole('link', { name: tripCopy[lang].lineRecord, exact: true }).first(),
			).toHaveAttribute('href', localizeHref('/lines/' + route, lang, provider));
			await expect(page).toHaveTitle(heading + ' · ' + lineLabel + ' · Transit');
		}
	}
});

test('Live now lists predictions under their line, statuses in words', async ({ page }) => {
	const provider = fixture('manifest.json').provider;
	await page.goto(localizeHref(`/stop/${stop}?tab=detail`, locale, provider));
	const t = detailCopy[locale].live;
	const list = page.locator('[data-slot="stop-live-predictions"]');
	const rows = list
		.getByRole('table')
		.getByRole('row')
		.filter({ has: page.getByRole('rowheader') });
	const section = page.locator('[data-toc="stop-detail-departures"] [data-section-trigger]');
	if ((await section.getAttribute('aria-expanded')) === 'false') await section.click();
	await expect(rows).toHaveCount(departures.stops[stop].length);
	// One line listed: nothing to order yet.
	await expect(page.getByRole('combobox', { name: t.order })).toHaveCount(0);
	await expect(rows.nth(0).getByRole('cell').first()).toHaveText(new RegExp(t.bands.on_time));
	await expect(rows.nth(1).getByRole('cell').first()).toHaveText(new RegExp(t.bands.on_time));
	const link = page.getByRole('link', { name: t.record, exact: true });
	const href = new URL((await link.getAttribute('href'))!, page.url());
	expect(href.pathname).toBe('/stop/' + stop);
	expect(href.searchParams.get('frameMode')).toBe('record');
});

for (const lang of PUBLISHED_LOCALES)
	test(lang + ': Stop Record and Live share the selected city and dates', async ({ page }) => {
		await page.clock.setFixedTime(Date.parse('2026-11-23T16:00:00Z'));
		const path = localizeHref('/stop/S1', lang, 'stm');
		await page.goto(path + '&recordFrom=2026-11-08&recordTo=2026-11-14');
		const views = await openFrameControls(page, lang);
		const recordName = lang === 'fr' ? 'Bilan' : 'Record';
		const liveName = lang === 'fr' ? 'En direct' : 'Live now';
		await expect(views.getByRole('radio', { name: recordName, exact: true })).toBeChecked();
		await views.getByRole('radio', { name: liveName, exact: true }).click();
		await expect(page).toHaveURL(
			(url) =>
				url.searchParams.get('provider') === 'stm' &&
				url.searchParams.get('recordFrom') === '2026-11-08' &&
				url.searchParams.get('recordTo') === '2026-11-14' &&
				url.searchParams.get('frameMode') === 'live',
		);
		await page.goBack();
		await expect(
			(await openFrameControls(page, lang)).getByRole('radio', { name: recordName, exact: true }),
		).toBeChecked();
	});

test('the status page lists its record families on phones and says when data is missing', async ({
	page,
}) => {
	await page.goto('/status?frameMode=live');
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
	// The records index is open by default, outside the auditors' disclosure.
	const index = page.getByRole('list', {
		name: healthCopy[locale].historyCoverage.indexLabel,
		exact: true,
	});

	await expect(index.getByRole('button').first()).toBeVisible();
	expect(await index.getByRole('listitem').count()).toBe(7);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
		true,
	);
	const box = (await index.boundingBox())!;
	expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
	await expect(index.locator('[data-slot="absent-value"]').first()).toBeVisible();
});

for (const lang of PUBLISHED_LOCALES)
	for (const provider of ['stm', 'octranspo'])
		for (const width of [320, 390, 768, 1280])
			test(`${lang} ${provider} ${width}: trip report keeps long predictions, source context and delayed identity usable`, async ({
				page,
			}, info) => {
				const lineId = provider === 'stm' ? '80' : '1-373';
				const count = provider === 'stm' ? 19 : 23;
				let oldCapture = false;
				let failedReport = false;
				const generated = fixture('trips.json').generated_utc;
				const names = Array.from({ length: count }, (_, i) => ({
					id: `R48-${i}`,
					name: `Station Université de Montréal / Boulevard Édouard-Montpetit et chemin de la Côte-des-Neiges ${i + 1}`,
					lat: 45.5,
					lon: -73.6,
				}));
				const predictions = names.map((stop, i) => ({
					stop: stop.id,
					eta_utc: '2026-06-15T12:05:00Z',
					delay_min: i % 4 === 0 ? -2 : i % 4 === 1 ? 0 : i % 4 === 2 ? null : 6,
				}));
				let releaseReport = () => {},
					releaseSchedule = () => {};
				let reportReady = Promise.resolve(),
					scheduleReady = Promise.resolve();
				await page.addInitScript(() =>
					Object.defineProperty(navigator, 'clipboard', {
						configurable: true,
						value: {
							writeText: async (text: string) => {
								Object.assign(window, { tripCopied: text });
							},
						},
					}),
				);
				await page.route(liveTripsUrl, async (route) => {
					await reportReady;
					if (failedReport) return route.fulfill({ status: 503, body: 'unavailable' });
					const trip = new URL(route.request().url()).searchParams.get('trip');
					const captured = oldCapture ? '2026-06-15T11:50:00Z' : generated;
					return route.fulfill({
						json: captureTripReport(
							provider,
							captured,
							trip === 'R48' ? [captureTrip(trip, lineId, predictions, 360)] : [],
						),
					});
				});
				await page.route(`**/api/schedule-edition?city=${provider}`, async (route) => {
					await scheduleReady;
					return route.fulfill({
						json: {
							schedule: {
								date: generated.slice(0, 10),
								routes: [{ id: lineId, short: lineId, long: 'Fixture public line', type: 3 }],
								stops: names,
								route_directions: {
									[lineId]: [
										{
											dir: 0,
											headsign: 'Fixture terminal',
											stops: names.map((stop, i) => ({ id: stop.id, seq: i + 1, name: stop.name })),
										},
									],
								},
							},
						},
					});
				});
				{
					await page.setViewportSize({ width, height: 900 });
					reportReady = new Promise<void>((resolve) => {
						releaseReport = resolve;
					});
					scheduleReady = new Promise<void>((resolve) => {
						releaseSchedule = resolve;
					});
					await page.goto(localizeHref('/trip/R48', lang, provider));
					const header = page.locator('[data-slot="article-header"]');
					await expect(page.getByRole('heading', { level: 1 })).toHaveText(
						tripCopy[lang].reportTitle,
					);
					await waitForFrameClearance(page);
					const before = await header.boundingBox();
					releaseReport();
					const table = page.getByRole('table', {
						name: tripCopy[lang].reportedPredictions,
						exact: true,
					});
					await expect(table.getByRole('rowheader')).toHaveCount(6);
					await expect(table.getByRole('rowheader').first()).toContainText(
						lang === 'en' ? 'name unavailable' : 'nom indisponible',
					);
					await expect(page.locator('.trip-verdict [data-slot="status-badge"]')).toHaveAttribute(
						'data-status',
						'late',
					);
					await expect(page.locator('.trip-verdict-delay')).toHaveText('+6 min');
					expect((await header.boundingBox())!.height).toBe(before!.height);
					await expect(page.locator('.trip-direction')).toHaveCount(0);
					releaseSchedule();
					await expect(table.locator('.trip-stop-name').first()).toHaveText(names[0].name);
					await expect(table.getByRole('rowheader').first().getByRole('link')).toHaveAccessibleName(
						`${tripCopy[lang].viewStop} ${names[0].name}`,
					);
					await expect(page.locator('.trip-summary .trip-direction')).toHaveText(
						tripCopy[lang].toward('Fixture terminal'),
					);
					expect((await header.boundingBox())!.height).toBe(before!.height);
					await expect(page.locator('[data-slot="trip-report-time"] p time')).toHaveAttribute(
						'datetime',
						generated,
					);
					await expect(page.locator('[data-slot="trip-report-time"] p time')).toContainText(
						lang === 'en' ? 'EDT' : 'HAE',
					);
					const precedes = await page
						.locator('.trip-observed-caveat')
						.evaluate((element) =>
							Boolean(
								element.compareDocumentPosition(
									element.closest('section')!.querySelector('table')!,
								) & Node.DOCUMENT_POSITION_FOLLOWING,
							),
						);
					expect(precedes).toBe(true);
					const expand = page.getByRole('button', {
						name: tripCopy[lang].showAll(count),
						exact: true,
					});
					await expand.press('Enter');
					await expect(table.getByRole('rowheader')).toHaveCount(count);
					const links = table.getByRole('rowheader').getByRole('link');
					expect(
						await links.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href'))),
					).toEqual(names.map((stop) => localizeHref('/stop/' + stop.id, lang, provider)));
					await links.first().focus();
					await expect(links.first()).toBeFocused();
					await links.first().press('Tab');
					await expect(links.nth(1)).toBeFocused();
					const defects = await table.evaluate((element) => {
						const problems: string[] = [];
						for (const link of element.querySelectorAll<HTMLElement>('.trip-stop-link')) {
							const name = link.querySelector<HTMLElement>('.trip-stop-name')!;
							if (link.getBoundingClientRect().height < 44) problems.push('small link');
							if (
								name.scrollHeight > name.clientHeight + 1 ||
								name.scrollWidth > name.clientWidth + 1
							)
								problems.push('clipped name');
							if (getComputedStyle(name).fontFamily.toLowerCase().includes('mono'))
								problems.push('mono name');
						}
						for (const cell of element.querySelectorAll('th,td')) {
							const box = cell.getBoundingClientRect();
							if (box.width && box.right > document.documentElement.clientWidth + 1)
								problems.push('cell overflow');
							if (getComputedStyle(cell).wordBreak === 'break-all') problems.push('word shredded');
						}
						return problems;
					});
					expect(defects, `${lang} ${provider} ${width}`).toEqual([]);
					await expect(
						page.getByRole('link', { name: tripCopy[lang].lineRecord, exact: true }).first(),
					).toHaveAttribute('href', localizeHref('/lines/' + lineId, lang, provider));
					const download = page.getByRole('link', { name: tripCopy[lang].download, exact: true });
					const csv = decodeURIComponent(
						(await download.getAttribute('href'))!.split(',').slice(1).join(','),
					);
					expect(csv.split('\r\n')).toHaveLength(count + 1);
					expect(csv).toContain('"schema_version","methodology_version","publish_generation_id"');
					expect(csv).toContain(
						`,2,"capture-live-v2","${provider}@trip_updates:${generated}","${generated}","${generated}"`,
					);
					expect(csv.split('\r\n')[1].endsWith(',-2')).toBe(true);
					await page.getByRole('button', { name: tripCopy[lang].copyLive, exact: true }).click();
					expect(await page.evaluate(() => Reflect.get(window, 'tripCopied'))).toBe(
						`https://transit1.yesid.dev${localizeHref('/trip/R48', lang, provider)}`,
					);
					await page.getByRole('button', { name: tripCopy[lang].showFewer, exact: true }).click();
					await expect(table.getByRole('rowheader')).toHaveCount(6);
					expect(await page.locator('html').evaluate((node) => node.scrollWidth)).toBe(width);
					if (width === 320 || width === 1280) {
						await table.getByRole('rowheader').first().scrollIntoViewIfNeeded();
						await page.screenshot({
							path: info.outputPath(`trip-${lang}-${provider}-${width}.png`),
						});
					}
				}
				await page.goto(localizeHref('/trip/R48-missing', lang, provider));
				await expect(page.getByTestId('trip-standdown')).toContainText(
					tripCopy[lang].standDownBody,
				);
				await expect(
					page.getByRole('link', { name: tripCopy[lang].findLine, exact: true }),
				).toHaveAttribute('href', localizeHref('/lines', lang, provider));
				await expect(
					page.getByRole('link', { name: tripCopy[lang].search, exact: true }),
				).toHaveAttribute('href', localizeHref('/search', lang, provider));

				oldCapture = true;
				await page.goto(localizeHref('/trip/R48', lang, provider));
				await expect(page.getByTestId('trip-report-notice')).toContainText(
					tripCopy[lang].reportBehind,
				);
				await expect(page.locator('[data-slot="trip-report-time"] p time')).toHaveAttribute(
					'datetime',
					'2026-06-15T11:50:00Z',
				);
				await expect(page.locator('[data-slot="freshness-stamp"]')).toHaveAttribute(
					'data-age-seconds',
					'630',
				);
				await expect(page.getByRole('table').getByRole('rowheader')).toHaveCount(6);
				failedReport = true;
				await page.goto(localizeHref('/trip/R48', lang, provider));
				await expect(
					page.locator('[data-slot="edge-state"][data-variant="error-v1"]'),
				).toBeVisible();
				await expect(page.getByTestId('trip-standdown')).toHaveCount(0);
				await expect(page.locator('[data-slot="trip-report-time"]')).toHaveCount(0);
			});
