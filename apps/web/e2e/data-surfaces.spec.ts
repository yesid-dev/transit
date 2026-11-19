import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

import { copy as healthCopy } from '../src/lib/features/health/health.copy';
import { stopReliabilityCopy } from '../src/lib/features/stops/reliability/stops-reliability.copy';
import { detailCopy } from '../src/lib/features/stops/stops.copy';
import { createLineDirectory } from '../src/lib/site/lineDirectory';
import { routeNameFallback } from '../src/lib/site/nameFallback';
import { tripCopy } from '../src/lib/features/trips/trips.copy';
import { DEFAULT_LOCALE as locale, PUBLISHED_LOCALES } from '../src/lib/i18n/config';
import { indexCopy } from '../src/lib/features/lines/lines.copy';
import { formatRecordDates } from '../src/lib/features/lines/reliability/recordDates';
import { localizeHref } from '../src/lib/i18n/routing';
import { STATUS_LABELS } from '../src/lib/v1/enumLabels';
import { stampCopy } from '../src/lib/v1/stamp.copy';
import { intl } from '../src/lib/i18n/copy';
import { csvTable } from '../src/lib/features/lines/reliability/__fixtures__/csvTable';
import { indexCopy as stopsIndexCopy } from '../src/lib/features/stops/stops.copy';
import { transitTerms } from '../src/lib/i18n/transitTerms.copy';

const fixture = (name: string) =>
	JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'));
const departures = fixture('departures.json');
const stop = Object.keys(departures.stops)[0]!;
const trips = fixture('trips.json').trips;
const grains = fixture('stop-reliability.json').periods.map(
	(period: { grain: string }) => period.grain,
);
// Inside the live data's 30 s freshness window.
const now = Date.parse(departures.generated_utc) + 30_000;

for (const lang of PUBLISHED_LOCALES)
	test(`${lang}: record pages show only the record stamp form`, async ({ page }) => {
		const manifest = fixture('manifest.json');
		const bundle = fixture('../scripts/__fixtures__/b9/rich.json').files;
		const day = bundle['historic/receipts/index.json'].dates.at(-1);
		// The core server synthesizes the receipt with its live fixture's publication date.
		const records = [
			['hotspots', fixture('hotspots.json').generated_utc, null],
			['repeat-offenders', fixture('repeat-offenders.json').generated_utc, null],
			['alerts', fixture('alerts.json').generated_utc, null],
			['receipt', manifest.files.live.generated_utc, day],
			['metrics', fixture('provenance.json').generated_utc, null],
		];
		// Supply the empty alerts fixture at the record endpoint absent from the core server.
		await page.route('**/historic/alert_history.json', (route) =>
			route.fulfill({ json: fixture('alerts.json') }),
		);
		const date = (key: string) =>
			intl
				.dateTime(lang, {
					month: 'short',
					day: 'numeric',
					timeZone: 'UTC',
					...(!manifest.tz ? { year: 'numeric' as const } : {}),
				})
				.format(new Date(key));
		for (const [path, generated, day] of records) {
			const published = generated.slice(0, 10);
			const expected = stampCopy[lang].record(
				day ? date(day) : null,
				date(published),
				day ? 'day' : 'window',
			);
			await page.goto(localizeHref(`/${path}`, lang, manifest.provider));
			const header = page.locator('[data-slot="article-header"]');
			await expect(header.locator('time')).toHaveText(expected);
			await expect(header.locator('time')).toHaveAttribute('datetime', published);
			await expect(page.locator('[data-slot="article-keywords"]')).toHaveCount(0);
			await expect(page.locator('[data-slot="stat-freshness"]')).toHaveCount(0);
		}
	});

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
	await page.clock.setFixedTime(now);
});

// SurfaceRail is a pill and sheet below 1024px.
const railIsSheet = (page: Page) => page.viewportSize()!.width < 1024;

// Every element a CSS animation or transition starts on, recorded from page load.
const recordMotion = () => {
	const started: Element[] = [];
	Object.assign(window, { started });
	for (const type of ['animationstart', 'transitionrun'])
		addEventListener(type, (event) => started.push(event.target as Element), true);
};

const r = stopReliabilityCopy[locale];
const railPill = (page: Page) =>
	page.getByRole('button', { name: new RegExp(`^${r.controlsLabel}\\b`) });

// Server markup shows the pill before hydration wires it; retry the click until the sheet opens.
async function openRail(page: Page) {
	const sheet = page.getByRole('dialog', { name: r.controlsLabel, exact: true });
	await expect(async () => {
		if (!(await sheet.isVisible())) await railPill(page).click();
		await expect(sheet).toBeVisible({ timeout: 1_000 });
	}).toPass();
	return sheet;
}

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

test('status chips filter the departures and report their pressed state', async ({ page }) => {
	await page.goto(`/stop/${stop}?tab=detail`);
	const t = detailCopy[locale].next;
	const late = page
		.getByRole('group', { name: t.filter.statusLabel })
		.getByRole('button', { name: STATUS_LABELS[locale].late });
	const rows = page
		.getByRole('table', { name: t.table.caption })
		.getByRole('row')
		.filter({
			has: page.getByRole('rowheader'),
		});
	const lateCount = departures.stops[stop].filter(
		(d: { delay_min: number }) => d.delay_min > 0,
	).length;

	await expect(rows).toHaveCount(departures.stops[stop].length);
	// Server markup shows the chips before hydration wires them; retry until one responds.
	await expect(async () => {
		if ((await late.getAttribute('aria-pressed')) !== 'true') await late.click();
		await expect(late).toHaveAttribute('aria-pressed', 'true', { timeout: 1_000 });
	}).toPass();
	await expect(rows).toHaveCount(lateCount);
	await late.click();
	await expect(late).toHaveAttribute('aria-pressed', 'false');
	await expect(rows).toHaveCount(departures.stops[stop].length);
});

test('the roll-up period is a radio group the arrow keys move through', async ({ page }) => {
	await page.goto(`/stop/${stop}?tab=reliability`);
	if (railIsSheet(page)) await openRail(page);
	const group = page.getByRole('radiogroup', { name: r.grain.label }).first();
	const checked = group.getByRole('radio', { checked: true });

	// One enabled choice per grain the fixture publishes; the others stay listed but disabled.
	await expect(group.getByRole('radio', { disabled: false })).toHaveCount(grains.length);
	const before = (await checked.textContent())!;
	// Server markup shows the choices before hydration wires them; retry until the keys respond.
	await expect(async () => {
		if ((await checked.textContent()) === before) {
			await checked.focus();
			await page.keyboard.press('ArrowRight');
		}
		await expect(checked).not.toHaveText(before, { timeout: 1_000 });
	}).toPass();
	await expect(checked).toBeFocused();
});

for (const lang of PUBLISHED_LOCALES) {
	test(`${lang}: the stop tabs keep the open tab in the URL without adding history`, async ({
		page,
	}) => {
		await page.goto(localizeHref(`/stop/${stop}`, lang));
		const entries = await page.evaluate(() => history.length);
		// The record last, so the loop ends where the bare URL started.
		for (const [key, name] of Object.entries(detailCopy[lang].tabs).reverse()) {
			const tab = page.getByRole('tab', { name, exact: true });
			// Server markup shows the tabs before hydration wires them; retry until one responds.
			await expect(async () => {
				if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
				await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: 1_000 });
			}).toPass();
			await expect(page).toHaveURL(
				(url) => url.searchParams.get('tab') === (key === 'reliability' ? null : key),
			);
			expect(await page.evaluate(() => history.length)).toBe(entries);
			if (key === 'reliability') continue;
			await page.reload();
			await expect(tab).toHaveAttribute('aria-selected', 'true');
		}
	});
}

test('on desktop the stop tabs sit centred in their toolbar', async ({ page }, testInfo) => {
	test.skip(
		testInfo.project.name !== 'desktop',
		'the tab list fills the toolbar below desktop widths',
	);
	await page.goto(`/stop/${stop}`);
	// The toolbar is the tab list's first wider ancestor.
	const [list, bar] = await page.getByRole('tablist').evaluate((element) => {
		let bar = element.parentElement!;
		while (bar.getBoundingClientRect().width <= element.getBoundingClientRect().width + 1)
			bar = bar.parentElement!;
		return [element, bar].map((node) => node.getBoundingClientRect().toJSON());
	});
	expect(list.width).toBeLessThan(bar.width);
	expect(Math.abs(list.x + list.width / 2 - (bar.x + bar.width / 2))).toBeLessThanOrEqual(1);
});

test('below 1024px the view rail opens as a dialog and Escape returns to its pill', async ({
	page,
}) => {
	test.skip(!railIsSheet(page), 'the rail is a sheet only below 1024px');
	await page.addInitScript(recordMotion);
	await page.goto(`/stop/${stop}?tab=reliability`);
	const sheet = await openRail(page);
	// Reduced motion (the suite's default): nothing on the sheet animated in; the click ripple is not part of it.
	expect(
		await sheet.evaluate((surface) =>
			(window as unknown as { started: Element[] }).started
				.filter((target) => target.contains(surface) || surface.contains(target))
				.map((target) => target.getAttribute('class')),
		),
	).toEqual([]);

	await expect(sheet.getByRole('radiogroup', { name: r.grain.label })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(sheet).toBeHidden();
	await expect(railPill(page)).toBeFocused();
});

test('the status page lists its record families on phones and says when data is missing', async ({
	page,
}) => {
	await page.goto('/status');
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

test('rankings name lines by number in both languages', async ({ page }) => {
	// Hotspots ranks complete weeks; serve the fixture's ranked rows as one.
	const week = fixture('hotspots.json');
	week.by_grain = week.by_grain.map((grain: object) => ({
		...grain,
		grain: 'week',
		date: '2026-06-08',
		window_end: '2026-06-14',
	}));
	await page.route('**/historic/hotspots.json', (route) => route.fulfill({ json: week }));
	for (const lang of PUBLISHED_LOCALES) {
		await page.goto(localizeHref('/hotspots', lang));
		await expect(page.locator('[data-slot="hotspots-verdict"]')).toHaveCount(0);
		const unindexed = page.locator('[data-slot="hotspot-rows"]').getByRole('button', {
			name: new RegExp(`\\b${lang === 'fr' ? 'Ligne' : 'Line'} Lansdowne\\.`),
		});
		await unindexed.scrollIntoViewIfNeeded();
		await expect(unindexed).toBeVisible();
		await expect(unindexed.locator('[data-slot="hotspot-row-name"]')).toHaveText('Lansdowne');
		await page.goto(localizeHref('/repeat-offenders', lang));
		const offender = page.locator('[data-slot="offender-rows"]').getByRole('button', {
			name: new RegExp(
				`\\b${lang === 'fr' ? 'Trajet T1 sur la ligne 1' : 'Trip T1 on line 1'} \\(Confederation\\)\\.`,
			),
		});
		await expect(offender).toBeVisible();
		await expect(offender.locator('[data-slot="offender-row-line"]')).toHaveText('Confederation');
		await page.goto(localizeHref('/receipt', lang));
		await expect(
			page.locator('[data-slot="receipt-worst"]').getByRole('link', {
				name: /^1 · Confederation/,
			}),
		).toContainText('1 · Confederation');
	}
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
					releaseRoute = () => {},
					releaseNames = () => {};
				let reportReady = Promise.resolve(),
					routeReady = Promise.resolve(),
					namesReady = Promise.resolve();
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
				await page.route(
					/\/v1\/(?:stm|octranspo)\/(?:live\/trips\.json|static\/stops_index\.json|static\/routes\/[^/]+\.json)(?:\?|$)/,
					async (route) => {
						const path = new URL(route.request().url()).pathname;
						if (path.endsWith('/live/trips.json')) {
							await reportReady;
							if (failedReport) {
								await route.fulfill({ status: 503, body: 'unavailable' });
								return;
							}
							await route.fulfill({
								json: {
									generated_utc: generated,
									feed_captured_utc: oldCapture ? '2026-06-15T11:50:00Z' : generated,
									schema_version: 1,
									methodology_version: 'live-2',
									publish_generation_id: `${provider}@${generated}`,
									trips: {
										R48: { status: 'severe', delay_min: 4, route: lineId, stops: predictions },
									},
								},
							});
						} else if (path.endsWith('/stops_index.json')) {
							await namesReady;
							await route.fulfill({ json: { generated_utc: generated, stops: names } });
						} else {
							await routeReady;
							await route.fulfill({
								json: {
									generated_utc: generated,
									id: lineId,
									long: 'Fixture public line',
									directions: [
										{
											dir: 0,
											headsign: 'Fixture terminal',
											stops: names.map((stop, i) => ({ id: stop.id, seq: i + 1, name: stop.name })),
										},
									],
								},
							});
						}
					},
				);
				{
					await page.setViewportSize({ width, height: 900 });
					reportReady = new Promise<void>((resolve) => {
						releaseReport = resolve;
					});
					routeReady = new Promise<void>((resolve) => {
						releaseRoute = resolve;
					});
					namesReady = new Promise<void>((resolve) => {
						releaseNames = resolve;
					});
					await page.goto(localizeHref('/trip/R48', lang, provider));
					await page.evaluate(() => document.fonts.ready);
					const header = page.locator('[data-slot="article-header"]');
					await expect(page.getByRole('heading', { level: 1 })).toHaveText(
						tripCopy[lang].reportTitle,
					);
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
						'severe',
					);
					await expect(page.locator('.trip-verdict-delay')).toHaveText('+4 min');
					expect((await header.boundingBox())!.height).toBe(before!.height);
					await expect(page.locator('.trip-direction')).toHaveCount(0);
					releaseRoute();
					releaseNames();
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
						`,1,"live-2","${provider}@${generated}","${generated}","${generated}"`,
					);
					expect(csv.split('\r\n')[1].endsWith(',-2')).toBe(true);
					await page.getByRole('button', { name: tripCopy[lang].copyLive, exact: true }).click();
					expect(await page.evaluate(() => Reflect.get(window, 'tripCopied'))).toBe(
						`https://transit.yesid.dev${localizeHref('/trip/R48', lang, provider)}`,
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
					generated,
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

// UX-T4.9/T4.10: the Lines directory is a finder of the current published records.
const DIRECTORY_LONG_NAME =
	'Sherbrooke / Station Université de Montréal et chemin de la Côte-des-Neiges / Terminus des voyageurs';
const DIRECTORY_IDS = Array.from({ length: 235 }, (_, index) => String(index + 1));
const DIRECTORY_ROUTE_PUBLICATION = {
	generated_utc: '2026-11-11T05:00:00Z',
	methodology_version: 'reliability-2',
};
const DIRECTORY_RECORD_QUERY = new URLSearchParams({
	from: '2026-11-04',
	to: '2026-11-10',
	published: DIRECTORY_ROUTE_PUBLICATION.generated_utc,
	method: DIRECTORY_ROUTE_PUBLICATION.methodology_version,
}).toString();
/** A published line whose id is not an invented ASCII alphabet: it is used verbatim in the URL. */
const OPAQUE_LINE = { id: 'ligne 24/été', short: '24 bis', long: 'Ligne opaque', type: 3 } as const;

async function stubLinesDirectory(
	page: Page,
	options: { opaque?: boolean } = {},
): Promise<{ indexRequests: number[]; fileRequests: string[] }> {
	const indexRequests: number[] = [];
	const fileRequests: string[] = [];
	const members = options.opaque
		? [...DIRECTORY_IDS.slice(0, 40), OPAQUE_LINE.id]
		: DIRECTORY_IDS.slice(0, 40);
	const week = { window_start: '2026-11-04', window_end: '2026-11-10' };
	const ranked = (
		id: string,
		numerator: number,
		denominator: number,
		pct: number,
		rank: number,
	) => ({
		id,
		state: 'ranked' as const,
		rank,
		numerator,
		denominator,
		pct,
		...week,
	});
	const index = {
		schema_version: 1,
		methodology_version: 'reliability-2',
		generated_utc: '2026-11-11T07:00:00Z',
		published_utc: '2026-11-11T07:00:00Z',
		next_publish_utc: '2026-11-18T07:00:00Z',
		route_ids: members,
		weekly_routes: [
			ranked('77', 40, 100, 40, 1),
			ranked('7', 55, 100, 55, 2),
			{
				id: '2',
				state: 'too_few_units' as const,
				window_start: '2026-10-28',
				window_end: '2026-11-03',
			},
		],
	};
	const routes = [
		...DIRECTORY_IDS.map((id, position) => ({
			id,
			short: id,
			long: position === 0 ? DIRECTORY_LONG_NAME : `Line ${id} route`,
			type: id === '4' ? 1 : id === '2' ? 0 : 3,
		})),
		...(options.opaque ? [OPAQUE_LINE] : []),
	];
	const routeFile = (id: string) => {
		const onTime = id === '5' ? 500 : 900;
		return {
			...DIRECTORY_ROUTE_PUBLICATION,
			id,
			periods_by_grain: [
				{ grain: 'day', date: '2026-11-10' },
				{
					grain: 'week',
					date: '2026-11-04',
					by_daytype: [{ grain: 'weekday', observation_count: 1000, on_time: onTime }],
				},
			],
			periods: [{ grain: 'day', date: '2026-11-10', observation_count: 1000, on_time: onTime }],
		};
	};
	await page.route('**/v1/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith('/static/routes_index.json'))
			return route.fulfill({
				json: { generated_utc: '2026-11-11T05:00:00Z', routes },
			});
		if (path.endsWith('/historic/route_reliability/index.json')) {
			indexRequests.push(1);
			return route.fulfill({ json: index });
		}
		const file = path.match(/\/historic\/route_reliability\/([^/]+)\.json$/u);
		if (file) fileRequests.push(file[1]);
		if (file && members.includes(file[1])) return route.fulfill({ json: routeFile(file[1]) });
		if (path.endsWith('/provenance.json'))
			return route.fulfill({
				json: {
					generated_utc: '2026-11-11T05:00:00Z',
					methodology: { min_n_rate: 30, wilson_z: 1.96 },
					gaps: ['metro_realtime'],
				},
			});
		return route.continue();
	});
	return { indexRequests, fileRequests };
}

/** Words split across lines inside a row: the directory must break between words, never inside one. */
function directoryBrokenWords(): string[] {
	const words: string[] = [];
	for (const row of document.querySelectorAll('[data-slot="entity-result-row"]')) {
		const bounds = row.getBoundingClientRect();
		const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
		while (walker.nextNode()) {
			const node = walker.currentNode;
			for (const match of node.textContent!.matchAll(/\S+/g)) {
				// A break after a hyphen is normal typography: each hyphen-delimited part must stay whole.
				let offset = 0;
				for (const part of match[0].split(/(?<=-)/u)) {
					const start = match.index! + offset;
					offset += part.length;
					if (!part.trim()) continue;
					const range = document.createRange();
					range.setStart(node, start);
					range.setEnd(node, start + part.length);
					const rects = [...range.getClientRects()];
					if (
						new Set(rects.map((rect) => Math.round(rect.top))).size > 1 ||
						rects.some((rect) => rect.left < bounds.left - 1 || rect.right > bounds.right + 1)
					)
						words.push(part);
				}
			}
		}
	}
	return words;
}

for (const lang of PUBLISHED_LOCALES)
	for (const provider of ['stm', 'octranspo'])
		for (const width of [320, 390, 768, 1280])
			test(`${lang} ${provider} ${width}: the lines directory finds every published line`, async ({
				page,
			}) => {
				await page.clock.setFixedTime(Date.parse('2026-11-12T12:00:00Z'));
				await stubLinesDirectory(page);
				await page.setViewportSize({ width, height: 900 });
				await page.goto(localizeHref('/lines', lang, provider), { waitUntil: 'networkidle' });

				const copy = indexCopy[lang];
				const comparisonDates = formatRecordDates('2026-11-04', '2026-11-10', lang)!;
				const counts = page.locator('[data-slot="directory-counts"]');
				await expect(counts).toHaveText(copy.counts('20', '235', '235'));

				const rows = page.locator('[data-slot="entity-result-row"]');
				await expect(rows).toHaveCount(20);
				const firstLine = localizeHref('/lines/1', lang, provider);
				await expect(rows.first().locator('a.directory-name')).toHaveAttribute(
					'href',
					`${firstLine}&${DIRECTORY_RECORD_QUERY}`,
				);
				// The whole published name, never truncated.
				await expect(rows.first().locator('.directory-long')).toHaveText(DIRECTORY_LONG_NAME);
				expect(await page.evaluate(directoryBrokenWords)).toEqual([]);
				expect(await page.locator('html').evaluate((node) => node.scrollWidth)).toBeLessThanOrEqual(
					width,
				);

				for (const selector of ['a.directory-name', 'button.directory-preview']) {
					const box = await page.locator(selector).first().boundingBox();
					expect(box!.height).toBeGreaterThanOrEqual(44);
				}

				// Every match stays reachable past the old 200-row ceiling, and the increment is honest.
				const more = page.locator('.directory-more-button');
				await expect(more).toHaveText(copy.showMore('20'));
				await more.click();
				await expect(rows).toHaveCount(40);
				const displayedCsv = page.locator('[data-slot="directory-csv"]');
				await expect(displayedCsv).toHaveAttribute('download', 'lines-displayed-records.csv');
				const exportedRows = decodeURIComponent(
					(await displayedCsv.getAttribute('href'))!.split(',').slice(1).join(','),
				).split('\r\n');
				// The file holds exactly the rows on screen, header included.
				expect(exportedRows).toHaveLength(41);
				expect(exportedRows[1]).toContain(`"${provider}"`);
				expect(exportedRows[1]).toContain('"2026-11-04"');

				// One selected preview: default on desktop, chosen by the rider on the phone.
				const preview = page.locator('[data-slot="directory-preview"]');
				const list = page.locator('[data-slot="entity-list"]');
				if (width < 1024) {
					await expect(preview).toHaveCount(0);
					const button = page.locator('button.directory-preview').first();
					await button.click();
					await expect(preview).toBeVisible();
					const heading = page.locator('[data-slot="directory-preview"] h2');
					await expect(heading).toBeFocused();
					const listBox = (await list.boundingBox())!;
					const previewBox = (await preview.boundingBox())!;
					expect(previewBox.y).toBeGreaterThanOrEqual(listBox.y + listBox.height - 1);
					await page.getByRole('button', { name: copy.backToResults, exact: true }).click();
					await expect(preview).toHaveCount(0);
					await expect(button).toBeFocused();
				} else {
					await expect(preview).toBeVisible();
					const listBox = (await list.boundingBox())!;
					const previewBox = (await preview.boundingBox())!;
					expect(previewBox.x).toBeGreaterThanOrEqual(listBox.x + listBox.width - 1);
				}

				// Comparison keeps the published order and explains the lines below it. The filter panel
				// starts closed below 1024px, as it does for every listing.
				if (width < 1024)
					await page.getByRole('button', { name: copy.controlsLabel, exact: true }).click();
				await page.getByTestId('lines-sort-worst').click();
				await expect(rows.first().locator('[data-slot="reliability-badge"]')).toContainText('40');
				const rankedHref = await rows.first().locator('a.directory-name').getAttribute('href');
				expect(rankedHref).toContain(`${localizeHref('/lines/77', lang, provider)}&`);
				await expect(page.locator('[data-slot="directory-comparison"]')).toHaveText(
					copy.comparisonContext(comparisonDates),
				);
				const excluded = rows.nth(3);
				expect(await excluded.locator('a.directory-name').getAttribute('href')).toContain(
					`${localizeHref('/lines/2', lang, provider)}&`,
				);
				await expect(excluded).toContainText(copy.unranked.too_few_units);
				await expect(excluded).toContainText(formatRecordDates('2026-10-28', '2026-11-03', lang)!);
				await expect(excluded).toContainText(copy.older);
				await expect(excluded.locator('[data-slot="reliability-badge"]')).toHaveCount(0);
			});

for (const lang of PUBLISHED_LOCALES)
	test(`${lang}: the last partial page is restored by the URL, not asked for again`, async ({
		page,
	}) => {
		await page.clock.setFixedTime(Date.parse('2026-11-12T12:00:00Z'));
		await stubLinesDirectory(page);
		await page.setViewportSize({ width: 320, height: 900 });
		await page.goto(localizeHref('/lines', lang, 'stm') + '&shown=240', {
			waitUntil: 'networkidle',
		});

		const copy = indexCopy[lang];
		const rows = page.locator('[data-slot="entity-result-row"]');
		await expect(rows).toHaveCount(235);
		await expect(page.locator('[data-slot="directory-counts"]')).toHaveText(
			copy.counts('235', '235', '235'),
		);
		// Every restored row still resolves its own evidence once it is read.
		await expect(rows.first().locator('[data-slot="reliability-badge"]')).toContainText('90');
		await rows.last().scrollIntoViewIfNeeded();
		await expect(rows.last()).toContainText(copy.notPublished);
		await expect(page.locator('.directory-more-button')).toHaveCount(0);
		// A reload keeps the same 235 rows: the URL carries the twenty-row page, not a partial one.
		await page.reload({ waitUntil: 'networkidle' });
		await expect(rows).toHaveCount(235);
		await expect(page.locator('[data-slot="directory-counts"]')).toHaveText(
			copy.counts('235', '235', '235'),
		);
	});

for (const lang of PUBLISHED_LOCALES)
	test(`${lang}: the problem filter lists by number and reports what it could not check`, async ({
		page,
	}) => {
		await page.clock.setFixedTime(Date.parse('2026-11-12T12:00:00Z'));
		await stubLinesDirectory(page);
		await page.setViewportSize({ width: 1280, height: 900 });
		await page.goto(localizeHref('/lines', lang, 'stm'), { waitUntil: 'networkidle' });

		const copy = indexCopy[lang];
		await page.getByTestId('lines-sort-worst').click();
		await page.getByTestId('lines-status-problem').click();
		await expect(page.locator('.directory-notice[role="status"]')).toContainText(
			copy.problemNotice,
		);
		await expect(page).toHaveURL(/status=problem/);
		await expect(page).not.toHaveURL(/sort=worst/);

		// Line 5 is the one uneven record; the rest of the checked lines are healthy or unmeasured.
		const rows = page.locator('[data-slot="entity-result-row"]');
		await expect(rows).toHaveCount(1);
		expect(await rows.first().locator('a.directory-name').getAttribute('href')).toContain(
			`${localizeHref('/lines/5', lang, 'stm')}&`,
		);
		await expect(page.locator('[data-slot="directory-counts"]')).toHaveText(
			copy.problemCounts('1', '235', '0', '0'),
		);
	});

for (const lang of PUBLISHED_LOCALES)
	test(`${lang}: without a published weekly ranking the directory says so and stays by number`, async ({
		page,
	}) => {
		// The default fixture publication predates the frozen clock, so no comparison is admitted.
		await page.clock.setFixedTime(Date.parse('2026-06-15T12:00:30Z'));
		await page.goto(localizeHref('/lines', lang, 'stm'), { waitUntil: 'networkidle' });

		const copy = indexCopy[lang];
		const control = page.getByTestId('lines-sort-worst');
		await expect(control).toBeDisabled();
		await expect(page.locator(`#${await control.getAttribute('aria-describedby')}`)).toHaveText(
			copy.comparisonUnavailable,
		);
		await expect(page).not.toHaveURL(/sort=worst/);
		const first = page.locator('a.directory-name').first();
		// This line publishes no record, so its link carries the provider and no invented period.
		expect(await first.getAttribute('href')).toBe(localizeHref('/lines/1-373', lang, 'stm'));

		// A query with no match explains itself and offers the way back.
		await page.getByTestId('lines-filter-input').fill('zzzz');
		await expect(page.getByText(copy.noMatch('zzzz'))).toBeVisible();
		await page.getByRole('button', { name: copy.clearFilters, exact: true }).click();
		await expect(page.locator('[data-slot="entity-result-row"]').first()).toBeVisible();
		await expect(page).not.toHaveURL(/q=/);
	});

test('en: an opaque published line id selects its record, and an unknown id reads nothing', async ({
	page,
}) => {
	await page.clock.setFixedTime(Date.parse('2026-11-12T12:00:00Z'));
	const stub = await stubLinesDirectory(page, { opaque: true });
	await page.setViewportSize({ width: 1280, height: 900 });
	const copy = indexCopy.en;
	await page.goto(
		`${localizeHref('/lines', 'en', 'stm')}&line=${encodeURIComponent(OPAQUE_LINE.id)}&shown=240`,
		{ waitUntil: 'networkidle' },
	);

	const preview = page.locator('[data-slot="directory-preview"]');
	await expect(preview.locator('h2')).toHaveText(copy.lineHeading(OPAQUE_LINE.short));
	// The record link carries the published id verbatim (URI-encoded), nothing invented.
	expect(await preview.locator('a', { hasText: copy.openRecord }).getAttribute('href')).toContain(
		encodeURIComponent(OPAQUE_LINE.id),
	);
	await expect
		.poll(() => stub.fileRequests.map((id) => decodeURIComponent(id)))
		.toContain(OPAQUE_LINE.id);

	// An id that is not a published line is a hint only: no preview, and no read for it.
	stub.fileRequests.length = 0;
	await page.goto(`${localizeHref('/lines', 'en', 'stm')}&line=${encodeURIComponent('ghost/id')}`, {
		waitUntil: 'networkidle',
	});
	await expect(page.locator('[data-slot="entity-result-row"]').first()).toBeVisible();
	await expect(preview).toHaveCount(0);
	await page.waitForTimeout(300);
	expect(stub.fileRequests.map((id) => decodeURIComponent(id))).not.toContain('ghost/id');
});

test('en: the selected preview cites the record it actually shows, with a copy fallback', async ({
	page,
}) => {
	await page.clock.setFixedTime(Date.parse('2026-11-12T12:00:00Z'));
	await stubLinesDirectory(page);
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto(localizeHref('/lines', 'en', 'stm'), { waitUntil: 'networkidle' });

	const copy = indexCopy.en;
	const preview = page.locator('[data-slot="directory-preview"]');
	const recordHref = `${localizeHref('/lines/1', 'en', 'stm')}&${DIRECTORY_RECORD_QUERY}`;
	const absoluteRecordUrl = new URL(recordHref, page.url()).href;
	await expect(preview).toContainText(copy.measure('90%'));
	await expect(preview.locator('.preview-dates')).toHaveText('November 4 to 10, 7 complete days');
	await expect(preview).toContainText(copy.basis('1,000'));
	await expect(preview.locator('a', { hasText: copy.openRecord })).toHaveAttribute(
		'href',
		recordHref,
	);
	await expect(preview.locator('a', { hasText: copy.schedule })).toHaveAttribute(
		'href',
		`${localizeHref('/lines/1', 'en', 'stm')}&tab=schedule`,
	);

	// Each answer offers its own export: the displayed rows and this selected record.
	const displayed = page.locator('[data-slot="directory-csv"]');
	await expect(displayed).toHaveAttribute('download', 'lines-displayed-records.csv');
	const displayedRows = decodeURIComponent(
		(await displayed.getAttribute('href'))!.split(',').slice(1).join(','),
	).split('\r\n');
	const cell = (line: string, name: string) =>
		csvTable(displayedRows[0] + '\r\n' + line)[0][name] ?? '';
	expect(displayedRows).toHaveLength(21);
	expect(cell(displayedRows[1], 'provider')).toBe('stm');
	expect(
		csvTable(
			decodeURIComponent((await displayed.getAttribute('href'))!.split(',').slice(1).join(',')),
		)[0].attribution,
	).toBe(fixture('manifest.json').attribution);
	const recordCsv = preview.locator('[data-slot="directory-record-csv"]');
	await expect(recordCsv).toHaveAttribute(
		'download',
		'line-1-2026-11-04-2026-11-10-selected-record.csv',
	);
	const recordRows = decodeURIComponent(
		(await recordCsv.getAttribute('href'))!.split(',').slice(1).join(','),
	).split('\r\n');
	expect(recordRows).toHaveLength(2);
	expect(cell(recordRows[1], 'value_pct')).toBe('90');
	expect(
		csvTable(
			decodeURIComponent((await recordCsv.getAttribute('href'))!.split(',').slice(1).join(',')),
		)[0].attribution,
	).toBe(fixture('manifest.json').attribution);
	expect(cell(recordRows[1], 'record_url')).toBe(absoluteRecordUrl);

	// Headless denies the clipboard, so the citation stays selectable instead of being lost.
	await preview.getByRole('button', { name: copy.cite, exact: true }).click();
	const fallback = preview.locator('textarea');
	await expect(fallback).toBeVisible();
	const citation = await fallback.inputValue();
	expect(citation).toContain('Line 1, STM');
	expect(citation).toContain('90%');
	expect(citation).toContain('November 4 to 10, 2026');
	expect(citation).toContain('1,000');
	expect(citation).toContain('method reliability-2');
	expect(citation).toMatch(
		new RegExp(`${absoluteRecordUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
	);
	expect(citation.toLowerCase()).not.toContain('permanent');
	await preview.getByRole('button', { name: copy.copyRecord, exact: true }).click();
	await expect(fallback).toHaveCount(2);
	await expect(preview.getByLabel(copy.copyFallback, { exact: true })).toHaveValue(
		absoluteRecordUrl,
	);
});

for (const lang of PUBLISHED_LOCALES)
	for (const id of ['1', '235'])
		test(`${lang}: phone URL preview ${id} focuses the report and returns to results`, async ({
			page,
		}) => {
			await page.clock.setFixedTime(Date.parse('2026-11-12T12:00:00Z'));
			await stubLinesDirectory(page);
			await page.setViewportSize({ width: 320, height: 900 });
			await page.goto(`${localizeHref('/lines', lang, 'stm')}&line=${id}`, {
				waitUntil: 'networkidle',
			});
			const preview = page.locator('[data-slot="directory-preview"]');
			await expect(preview.locator('h2')).toBeFocused();
			await expect(preview.locator('h2')).toBeInViewport();
			if (id === '1')
				await expect(preview.locator('.preview-dates')).toHaveText(
					lang === 'fr'
						? 'du 4 au 10 novembre, 7 jours complets'
						: 'November 4 to 10, 7 complete days',
				);
			await preview
				.getByRole('button', { name: indexCopy[lang].backToResults, exact: true })
				.click();
			await expect(preview).toHaveCount(0);
			const target =
				id === '1'
					? page.locator(`[data-directory-preview-id="${id}"]`)
					: page.locator('.directory-results');
			await expect(target).toBeFocused();
			await expect(target).toBeInViewport();
			await expect(page).not.toHaveURL(/line=/);
		});

// UX-T6.6/T6.7: the Stops finder lists every published stop with its weekly record, the same
// way the Lines directory does. STM publishes 8,383 stops a week; the seed is that size.
const FINDER_STOP_COUNT = 8_383;
const FINDER_LONG_NAME =
	'Abbott / Station Université de Montréal et chemin de la Côte-des-Neiges / Terminus des voyageurs';
const FINDER_WEEK = { window_start: '2026-11-04', window_end: '2026-11-10' };
/** The week as the stop record names it (`periodRange`), written out so the spec checks the words. */
const FINDER_RANGE = { en: 'November 4 to 10, 2026', fr: 'du 4 au 10 novembre 2026' } as const;

function finderStops() {
	return Array.from({ length: FINDER_STOP_COUNT }, (_, index) => ({
		id: `S${index + 1}`,
		name: index === 0 ? FINDER_LONG_NAME : `Stop ${index + 1}`,
		code: String(50001 + index),
		lat: 45.5 + (index % 100) * 0.001,
		lon: -73.6 - Math.floor(index / 100) * 0.001,
		mode: index === 2 ? 'metro' : 'bus',
		routes: ['24', '51', '80', '161', '435'],
	}));
}

/** A ranked weekly row whose share agrees with its counts, as the contract asks. */
function finderRanked(id: string, readings: number, late: number, rank: number) {
	return {
		id,
		state: 'ranked' as const,
		rank,
		numerator: readings - late,
		denominator: readings,
		pct: Math.round((100 * (readings - late)) / readings),
		severe_pct: Math.round((1000 * late) / readings) / 10,
		...FINDER_WEEK,
	};
}

async function stubStopsFinder(
	page: Page,
	options: { hold?: Promise<void> } = {},
): Promise<{ stopFiles: string[] }> {
	const stopFiles: string[] = [];
	const stops = finderStops();
	const index = {
		schema_version: 1,
		methodology_version: 'reliability-2',
		generated_utc: '2026-11-11T07:00:00Z',
		published_utc: '2026-11-11T07:00:00Z',
		next_publish_utc: '2026-11-18T07:00:00Z',
		route_ids: ['24'],
		weekly_routes: null,
		weekly_stops: [
			// Stop 8000 is first-ranked; the long-named stop's 1 late reading in 80 is exactly 1.25%.
			finderRanked('S8000', 100, 40, 1),
			finderRanked('S1', 80, 1, 2),
			{ id: 'S2', state: 'too_few_units' as const, ...FINDER_WEEK },
		],
	};
	const routes = ['24', '51', '80', '161', '435'].map((id) => ({
		id,
		short: id,
		long: `Line ${id}`,
		type: 3,
	}));
	await page.route('**/v1/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith('/static/stops_index.json'))
			return route.fulfill({ json: { generated_utc: '2026-11-11T05:00:00Z', stops } });
		if (path.endsWith('/static/routes_index.json'))
			return route.fulfill({ json: { generated_utc: '2026-11-11T05:00:00Z', routes } });
		if (path.endsWith('/historic/route_reliability/index.json')) {
			if (options.hold) await options.hold;
			return route.fulfill({ json: index });
		}
		if (/\/historic\/stop_reliability\//u.test(path)) stopFiles.push(path);
		return route.continue();
	});
	return { stopFiles };
}

const finderCount = (lang: (typeof PUBLISHED_LOCALES)[number], value: number) =>
	intl.number(lang).format(value);

for (const lang of PUBLISHED_LOCALES)
	for (const provider of ['stm', 'octranspo'])
		for (const width of [320, 390, 768, 1280])
			test(`${lang} ${provider} ${width}: the stops finder lists every published stop`, async ({
				page,
			}) => {
				await page.clock.setFixedTime(Date.parse('2026-11-12T12:00:00Z'));
				const { stopFiles } = await stubStopsFinder(page);
				await page.setViewportSize({ width, height: 900 });
				await page.goto(localizeHref('/stops', lang, provider), { waitUntil: 'networkidle' });

				const copy = stopsIndexCopy[lang];
				const total = finderCount(lang, FINDER_STOP_COUNT);
				await expect(page.locator('[data-slot="finder-counts"]')).toHaveText(
					copy.counts('20', total, total),
				);
				const rows = page.locator('[data-slot="entity-result-row"]');
				await expect(rows).toHaveCount(20);

				// The whole published name, linked to its record on the week the row shows.
				const first = rows.first();
				await expect(first.locator('a.finder-name')).toHaveText(FINDER_LONG_NAME);
				await expect(first.locator('a.finder-name')).toHaveAttribute(
					'href',
					`${localizeHref('/stop/S1', lang, provider)}&from=2026-11-04&to=2026-11-10`,
				);
				const period = detailCopy[lang].record.period(
					FINDER_RANGE[lang],
					transitTerms[lang].completeDays(7, '7'),
				);
				const figure = first.locator('[data-slot="stop-row-figure"]');
				await expect(figure).toHaveAccessibleName(
					copy.row.figureLabel(lang === 'fr' ? '1,3 %' : '1.3%', period),
				);
				// A stop without a share says so in words, never with a number.
				const tooFew = rows.nth(1);
				await expect(tooFew.locator('[data-slot="stop-row-state"] .finder-figure-pct')).toHaveText(
					copy.row.noShare,
				);
				await expect(tooFew).toContainText(copy.row.state.tooFew);

				expect(await page.evaluate(directoryBrokenWords)).toEqual([]);
				expect(await page.locator('html').evaluate((node) => node.scrollWidth)).toBeLessThanOrEqual(
					width,
				);
				for (const selector of ['a.finder-name', 'button.finder-button', '.finder-way']) {
					const box = await page.locator(selector).first().boundingBox();
					expect(box!.height).toBeGreaterThanOrEqual(44);
				}

				const more = page.getByRole('button', { name: copy.showMore('20'), exact: true });
				await more.click();
				await expect(rows).toHaveCount(40);

				// One selected preview: default on desktop, chosen by the rider on the phone.
				const preview = page.locator('[data-slot="stops-preview"]');
				const list = page.locator('[data-slot="entity-list"]');
				if (width < 1024) {
					await expect(preview).toHaveCount(0);
					const button = page.getByRole('button', {
						name: copy.previewStop(FINDER_LONG_NAME),
						exact: true,
					});
					await button.click();
					await expect(preview.locator('h2')).toBeFocused();
					const listBox = (await list.boundingBox())!;
					expect((await preview.boundingBox())!.y).toBeGreaterThanOrEqual(
						listBox.y + listBox.height - 1,
					);
				} else {
					await expect(preview).toBeVisible();
					const listBox = (await list.boundingBox())!;
					expect((await preview.boundingBox())!.x).toBeGreaterThanOrEqual(
						listBox.x + listBox.width - 1,
					);
				}
				await expect(preview.locator('h2')).toHaveText(FINDER_LONG_NAME);
				await expect(preview.locator('[data-slot="stops-preview-period"]')).toHaveText(period);
				const actions = transitTerms[lang].action;
				await expect(preview.getByRole('link', { name: actions.openRecord })).toHaveAttribute(
					'href',
					`${localizeHref('/stop/S1', lang, provider)}&from=2026-11-04&to=2026-11-10`,
				);
				const map = new URL(
					(await preview.getByRole('link', { name: actions.showOnMap }).getAttribute('href'))!,
					'http://localhost',
				);
				expect(map.searchParams.get('provider')).toBe(provider);
				expect(map.searchParams.get('stop')).toBe('S1');
				for (const height of await preview
					.locator('a, button')
					.evaluateAll((elements) =>
						elements.map((element) => element.getBoundingClientRect().height),
					))
					expect(height).toBeGreaterThanOrEqual(44);
				if (width < 1024)
					await page.getByRole('button', { name: copy.backToResults, exact: true }).click();

				// The published ranking keeps the publisher's order and says what it is. The filter
				// panel starts closed below 1024px, as it does for every listing.
				if (width < 1024)
					await page.getByRole('button', { name: copy.controlsLabel, exact: true }).click();
				await page.getByTestId('stops-sort-late').click();
				await expect(rows.first().locator('a.finder-name')).toHaveText('Stop 8000');
				await expect(page.locator('[data-slot="finder-order-context"]')).toHaveText(
					copy.orderContext(FINDER_RANGE[lang]),
				);
				// One weekly file answers every row: no stop's own history is read.
				expect(stopFiles).toEqual([]);
			});

for (const lang of PUBLISHED_LOCALES)
	for (const width of [320, 390, 1280])
		test(`${lang} ${width}: stops finder rows and preview keep their height when the weekly record arrives`, async ({
			page,
		}) => {
			await page.clock.setFixedTime(Date.parse('2026-11-12T12:00:00Z'));
			let release: () => void = () => {};
			const hold = new Promise<void>((resolve) => (release = resolve));
			await stubStopsFinder(page, { hold });
			await page.setViewportSize({ width, height: 900 });
			// The measured stop is selected, so its preview is open at every width while the file loads.
			await page.goto(localizeHref('/stops?stop=S1', lang, 'stm'), {
				waitUntil: 'domcontentloaded',
			});
			const preview = page.locator('[data-slot="stops-preview"]');
			await expect(preview).toBeVisible();
			const rows = page.locator('[data-slot="entity-result-row"]');
			await expect(rows).toHaveCount(20);
			await page.evaluate(() => document.fonts.ready);
			const heights = () =>
				rows.evaluateAll((elements) =>
					elements.slice(0, 3).map((element) => element.getBoundingClientRect().height),
				);
			const before = await heights();
			const list = (await page.locator('[data-slot="entity-list"]').boundingBox())!;
			const previewBefore = (await preview.boundingBox())!.height;
			release();
			await expect(rows.first().locator('[data-slot="stop-row-figure"]')).toBeVisible();
			await expect(rows.nth(1).locator('[data-slot="stop-row-state"]')).toBeVisible();
			const after = await heights();
			for (const [index, height] of after.entries())
				expect(Math.abs(height - before[index])).toBeLessThanOrEqual(1);
			const listAfter = (await page.locator('[data-slot="entity-list"]').boundingBox())!;
			expect(Math.abs(listAfter.height - list.height)).toBeLessThanOrEqual(1);
			await expect(preview.locator('[data-slot="stops-preview-csv"]')).toBeVisible();
			expect(Math.abs((await preview.boundingBox())!.height - previewBefore)).toBeLessThanOrEqual(
				1,
			);
		});
