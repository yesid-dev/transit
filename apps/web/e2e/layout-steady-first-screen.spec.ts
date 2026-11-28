import { expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { streamingLayoutTest as test } from './layout-test';
import {
	captureFixture,
	captureTrip,
	captureTripReport,
	captureUrl,
	captureVehicle,
	liveSummaryUrl,
	liveTripsUrl,
	overviewReadsCapture,
} from './capture-fixture';
import { designPassCases, type Screen } from './design-pass-cases';
import { settled } from './design-pass-measure';
import { localizeHref } from '../src/lib/i18n/routing';

type ShiftRect = { x: number; y: number; width: number; height: number };
type Shift = {
	at: number;
	value: number;
	sources: { node: string; previous: ShiftRect; current: ShiftRect }[];
};
type ShiftEntry = PerformanceEntry & {
	hadRecentInput: boolean;
	value: number;
	sources: {
		node: Node | null;
		previousRect: DOMRectReadOnly;
		currentRect: DOMRectReadOnly;
	}[];
};
type ShiftWindow = Window & { steadyShifts: Shift[] };

async function observeShifts(page: Page) {
	await page.addInitScript(() => {
		const shifts: Shift[] = [];
		const rect = ({ x, y, width, height }: DOMRectReadOnly): ShiftRect => ({
			x: Math.round(x),
			y: Math.round(y),
			width: Math.round(width),
			height: Math.round(height),
		});
		(window as ShiftWindow).steadyShifts = shifts;
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries() as ShiftEntry[]) {
				if (entry.hadRecentInput) continue;
				shifts.push({
					at: Math.round(entry.startTime),
					value: entry.value,
					sources: entry.sources.flatMap(({ node, previousRect, currentRect }) => {
						const element = node instanceof Element ? node : node?.parentElement;
						if (!element) return [];
						const section = element.closest('[id], [data-slot]');
						const label = section?.id
							? `${element.tagName} #${section.id}`
							: `${element.tagName} [${section?.getAttribute('data-slot') ?? ''}]`;
						return [{ node: label, previous: rect(previousRect), current: rect(currentRect) }];
					}),
				});
			}
		}).observe({ type: 'layout-shift', buffered: true });
	});
}

const time = Date.parse('2026-11-23T16:00:00Z');

async function holdParser(page: Page, path: string) {
	const { promise, resolve } = Promise.withResolvers<void>();
	await page.route(`**${path}`, async (route) => {
		await promise;
		// Restore the server markup before Svelte hydrates it.
		await route.fulfill({
			contentType: 'text/javascript',
			body: 'document.currentScript.remove()',
		});
	});
	return resolve;
}

test('Overview reserves the second card column before its HTML is parsed @layout', async ({
	page,
}, info) => {
	await observeShifts(page);
	const paint = () =>
		page.evaluate(
			() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
		);
	const headerGate = '/__header-parser-gate';
	const overviewGate = '/__overview-parser-gate';
	const releaseHeader = await holdParser(page, headerGate);
	const releaseOverview = await holdParser(page, overviewGate);
	const routePath = '/?provider=stm&recordFrom=2026-11-08&recordTo=2026-11-14';
	await page.route(
		(url) => url.pathname === '/' && url.searchParams.has('recordFrom'),
		async (route) => {
			const response = await route.fetch();
			const html = await response.text();
			const trailingControls = /<div class="nav-trailing\b[^"]*">/u;
			const secondCard = /<div data-slot="card"[^>]*\bclass="[^"]*\boverview-live\b[^"]*"[^>]*>/u;
			expect(trailingControls.test(html), 'the response contains the trailing nav controls').toBe(
				true,
			);
			expect(secondCard.test(html), 'the response contains the Live now card').toBe(true);
			// Pause first in the nav and then between the two Overview cards.
			await route.fulfill({
				response,
				body: html
					.replace(trailingControls, `<script src="${headerGate}"></script>$&`)
					.replace(secondCard, `<script src="${overviewGate}"></script>$&`),
			});
		},
	);
	try {
		await page.goto(routePath, { waitUntil: 'commit' });
		const nav = page.getByTestId('nav-pill');
		await expect(nav).toBeAttached();
		await expect(nav.getByTestId('nav-menu-toggle')).toHaveCount(0);
		await expect(nav).toHaveCSS('visibility', 'hidden');
		await page.evaluate(() => document.fonts.ready);
		await paint();
		releaseHeader();
		const grid = page.locator('[data-slot="screen-answer"]');
		const record = grid.getByRole('article', { name: 'Record', exact: true });
		const body = record.locator('[data-slot="record-card-body"]');
		await expect(body).toBeVisible();
		await expect(grid.getByRole('article')).toHaveCount(1);
		await expect(nav).toBeVisible();
		await page.evaluate(() => document.fonts.ready);
		await paint();
		const navBefore = await nav.boundingBox();
		const initialBody = await body.elementHandle();
		const before = await body.boundingBox();
		releaseOverview();
		await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
		const live = grid.getByRole('article', { name: 'Live now', exact: true });
		await expect(live).toBeVisible();
		await expect(body).toBeVisible();
		await paint();
		expect(await body.evaluate((element, initial) => element === initial, initialBody)).toBe(true);
		const after = await body.boundingBox();
		const navAfter = await nav.boundingBox();
		const shifts = await page.evaluate(() => (window as ShiftWindow).steadyShifts);
		await info.attach('overview-streamed-columns', {
			body: JSON.stringify({ before, after, navBefore, navAfter, shifts }),
			contentType: 'application/json',
		});
		expect.soft(after).toEqual(before);
		expect.soft(navAfter).toEqual(navBefore);
		expect((await live.boundingBox())!.x).toBeGreaterThan(after!.x);
		expect(
			shifts.reduce((sum, { value }) => sum + value, 0),
			JSON.stringify(shifts),
		).toBe(0);
	} finally {
		releaseHeader();
		releaseOverview();
	}
});
const widths = [390, 768, 1024, 1440];
const targets = new Set<Screen>([
	'overview',
	'overview-live',
	'network-health',
	'network-health-live',
	'lines',
	'line-record',
	'line-live',
	'stops',
	'stop-record',
	'daily',
	'data-health',
	'data-health-live',
	'alerts',
	'alerts-live',
	'how-we-measure',
	'download',
	'vehicle-record',
	'vehicle-live',
	// The lists that streamed their rows in after the first screen (closing scan S1).
	'vehicles-live',
	'stop-live',
	'search-query',
]);
const artwork = new Set<Screen>([
	'overview',
	'network-health',
	'line-record',
	'alerts',
	'vehicle-record',
]);
const captureRefresh = new Set<Screen>([
	'network-health-live',
	'line-live',
	'data-health-live',
	'alerts-live',
	'vehicle-live',
	'stop-live',
]);
const recordAnswers = new Set<Screen>([
	'overview',
	'network-health',
	'lines',
	'line-record',
	'stops',
	'stop-record',
	'daily',
	'data-health',
	'alerts',
	'vehicle-record',
]);

let recordVariant = 0;

for (const city of ['stm', 'octranspo'] as const)
	for (const locale of ['en', 'fr'] as const)
		for (const width of [1024, 1440]) {
			test(`Overview loads without shifting at ${width}px in ${city} ${locale} @layout`, async ({
				page,
				request,
			}, info) => {
				const fixture = `overview-load:${randomUUID()}`;
				const port = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';
				const endpoint = (action: 'hold' | 'release') =>
					`http://127.0.0.1:${port}/__overview/${action}?fixture=${encodeURIComponent(fixture)}`;
				let releaseCapture!: () => void;
				const capture = new Promise<void>((resolve) => (releaseCapture = resolve));
				await page.setViewportSize({ width, height: 900 });
				await page.clock.setFixedTime(time);
				await page.setExtraHTTPHeaders({ 'x-transit-fixture-hold': fixture });
				await observeShifts(page);
				const routes = city === 'stm' ? ['24', '67', '165'] : ['6', '7', '14'];
				await overviewReadsCapture(page);
				await page.route(captureUrl, async (route) => {
					await capture;
					await route.fulfill({
						json: {
							...captureFixture(time, {
								city,
								vehicle_positions: Array.from({ length: city === 'stm' ? 900 : 300 }, (_, index) =>
									captureVehicle(time, {
										id: `report-${index}`,
										vehicle_id: String(40061 + index),
										route_id: routes[index % routes.length],
										delay: index < 15 ? 480 : 0,
									}),
								),
							}),
							scheduled_now: city === 'stm' ? 920 : 320,
							non_responding: 20,
						},
					});
				});
				const fr = locale === 'fr';
				const record = page.getByRole('article', { name: fr ? 'Bilan' : 'Record', exact: true });
				const chart = record
					.getByRole('heading', { name: fr ? 'Part à l’heure par jour' : 'On-time share by day' })
					.locator('..');
				const live = page.getByRole('article', {
					name: fr ? 'En direct' : 'Live now',
					exact: true,
				});
				const snapshot = async () => ({
					chart: await chart.boundingBox(),
					liveCard: await live.boundingBox(),
					liveBody: await live.locator('[data-slot="record-card-body"]').boundingBox(),
					liveFooter: await live.locator('footer').boundingBox(),
				});
				const picture = async (state: 'waiting' | 'ready') => {
					const directory = process.env.TRANSIT_OVERVIEW_LOAD_EVIDENCE;
					if (directory)
						await page.screenshot({
							path: join(directory, `${city}-${locale}-${width}-${state}.png`),
							fullPage: true,
							animations: 'disabled',
						});
				};
				expect((await request.post(endpoint('hold'))).ok()).toBe(true);
				try {
					const response = await page.goto(
						localizeHref('/?recordFrom=2026-11-08&recordTo=2026-11-14', locale, city),
						{ waitUntil: 'commit' },
					);
					expect(response?.ok()).toBe(true);
					await expect(chart.locator('[data-record-pending]')).toBeVisible();
					await expect(live.locator('[data-record-pending]')).toBeVisible();
					await page.evaluate(() => document.fonts.ready);
					await settled(page);
					const waiting = await snapshot();
					await picture('waiting');
					expect((await request.post(endpoint('release'))).ok()).toBe(true);
					await expect(chart.locator('[data-slot="chart-line-series"]').first()).toBeVisible();
					await settled(page);
					const recordReady = await snapshot();
					releaseCapture();
					await expect(live.locator('tbody tr')).toHaveCount(3);
					await settled(page);
					const ready = await snapshot();
					const shifts = await page.evaluate(() => (window as ShiftWindow).steadyShifts);
					await picture('ready');
					await info.attach('overview-load-geometry', {
						body: JSON.stringify({ waiting, recordReady, ready, shifts }),
						contentType: 'application/json',
					});
					expect.soft(recordReady.chart).toEqual(waiting.chart);
					const liveGeometry = ({ liveCard, liveBody, liveFooter }: typeof ready) => ({
						bodyHeight: liveBody!.height,
						footerOffset: liveFooter!.y - liveCard!.y,
					});
					expect.soft(liveGeometry(ready)).toEqual(liveGeometry(recordReady));
					expect(shifts.reduce((sum, { value }) => sum + value, 0)).toBe(0);
				} finally {
					releaseCapture();
					await request.post(endpoint('release'));
				}
			});
		}

// A preloaded font that misses the first paint must not move the text. With font-display: swap,
// Inter arriving late moved the header links, the title row and the Live stamp by 2 to 8 px.
for (const [city, locale, width] of [
	['stm', 'en', 1440],
	['stm', 'fr', 1024],
] as const)
	test(`a late Inter font leaves the Overview in place at ${width}px in ${city} ${locale} @layout`, async ({
		page,
	}, info) => {
		await page.setViewportSize({ width, height: 900 });
		await page.clock.setFixedTime(time);
		await observeShifts(page);
		const { promise: held, resolve: release } = Promise.withResolvers<void>();
		await page.route(/\/inter-latin-wght-normal[\w.-]*\.woff2$/, async (route) => {
			await held;
			await route.continue();
		});
		const moving = page.locator(
			'[data-slot="site-header"] a, [data-slot="screen-title-row"], [data-slot="stamp"]',
		);
		const boxes = () =>
			moving.evaluateAll((elements) =>
				elements.map((element) => {
					const { x, y, width, height } = element.getBoundingClientRect();
					return [x, y, width, height].map((value) => Math.round(value * 10) / 10);
				}),
			);
		let before: number[][];
		let released: number;
		try {
			const response = await page.goto(
				localizeHref('/?recordFrom=2026-11-08&recordTo=2026-11-14', locale, city),
				{ waitUntil: 'commit' },
			);
			expect(response?.ok()).toBe(true);
			await expect(page.locator('html[data-hydrated]')).toBeAttached();
			await expect(page.locator('main [data-record-pending]')).toHaveCount(0);
			// Not settled(): it waits for document.fonts.ready, which waits for the held font.
			await page.evaluate(
				() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
			);
			expect(await page.evaluate(() => document.fonts.check('1em "Inter Variable"', 'a'))).toBe(
				false,
			);
			before = await boxes();
			released = await page.evaluate(() => performance.now());
		} finally {
			release();
		}
		await page.evaluate(() => document.fonts.ready);
		await settled(page);
		const after = await boxes();
		const shifts = (await page.evaluate(() => (window as ShiftWindow).steadyShifts.slice())).filter(
			({ at }) => at >= released,
		);
		await info.attach('late-font', {
			body: JSON.stringify({ before, after, shifts }),
			contentType: 'application/json',
		});
		expect(before.length).toBeGreaterThan(0);
		expect(after).toEqual(before);
		expect(shifts).toEqual([]);
	});

for (const { screen, href } of designPassCases.filter(
	(item) => item.provider === 'stm' && item.locale === 'en' && targets.has(item.screen),
)) {
	for (const city of ['stm', 'octranspo'] as const)
		for (const locale of ['en', 'fr'] as const)
			for (const width of widths) {
				const held = recordAnswers.has(screen) && !(screen === 'alerts' && city === 'octranspo');
				const index = held && screen !== 'stops' ? recordVariant++ : 0;
				test(`steady ${screen} ${city} ${locale} ${width}px @layout`, async ({
					page,
					request,
				}, info) => {
					const path = new URL(href, 'http://fixture');
					if (screen === 'alerts' || screen === 'network-health')
						path.searchParams.set('frameMode', 'record');
					if (screen === 'vehicle-record' && city === 'octranspo') path.pathname = '/vehicle/1';
					const port = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';
					// Give each request an isolated fixture window, distinct from the other layout specs.
					const october = new Date('2026-10-13T00:00:00Z').getTime();
					const day = (offset: number) =>
						new Date(october + offset * 86_400_000).toISOString().slice(0, 10);
					const position = widths.indexOf(width);
					let from = day(index % 24);
					let to = day((index % 24) + Math.floor(index / 24));
					if (screen === 'overview') {
						const first = locale === 'fr' ? 8 : 1;
						const november = (day: number) => `2026-11-${String(day).padStart(2, '0')}`;
						from = november(first);
						to = november(first + 6 + position);
					} else if (screen === 'stops') {
						from = day(24 + position + (locale === 'fr' ? widths.length : 0));
						to = '2026-11-20';
					} else if (screen === 'daily') {
						const first = locale === 'fr' ? 18 : 17;
						from = `2026-11-${first}`;
						to = `2026-11-${first + position}`;
					} else if (screen === 'data-health') {
						from = '2026-10-26';
						to = `2026-11-${(locale === 'fr' ? 19 : 15) + position}`;
					}
					// The hold is this test's own: another test asking for the same dates is never held.
					const fixture = `steady:${city}:${from}:${to}:${randomUUID()}`;
					const fixtureUrl = (action: 'hold' | 'release') =>
						`http://127.0.0.1:${port}/__overview/${action}?fixture=${encodeURIComponent(fixture)}`;
					const hold = (action: 'hold' | 'release') => request.post(fixtureUrl(action));
					if (held) {
						path.searchParams.set('recordFrom', from);
						path.searchParams.set('recordTo', to);
					}
					await page.setViewportSize({ width, height: 900 });
					await page.clock.install({ time: captureRefresh.has(screen) ? Date.now() : time });
					await page.setExtraHTTPHeaders({
						...(screen === 'alerts' ? { 'x-transit-fixture-scope': 'alerts' } : {}),
						...(held ? { 'x-transit-fixture-hold': fixture } : {}),
					});
					await page.addInitScript(
						(theme) => localStorage.setItem('theme', theme),
						locale === 'fr' ? 'dark' : 'light',
					);
					await observeShifts(page);
					if (screen === 'vehicles-live')
						// A city's fleet fills the first page of rows, as on the live site; Ottawa's feed
						// gives no direction or next stop.
						await page.route(captureUrl, async (route) => {
							const at = await page.evaluate(() => Date.now());
							const vehicle_positions = Array.from({ length: 30 }, (_, index) =>
								captureVehicle(at, {
									id: `report-${index}`,
									vehicle_id: String(40100 + index),
									...(city === 'octranspo' ? { direction_id: null, stop_id: null } : {}),
								}),
							);
							await route.fulfill({ json: captureFixture(at, { city, vehicle_positions }) });
						});
					if (held) expect((await hold('hold')).ok()).toBe(true);
					const listing = screen === 'lines' || screen === 'stops' || screen === 'vehicles';
					let listingStart: number | undefined;
					try {
						path.searchParams.delete('provider');
						const response = await page.goto(
							localizeHref(path.pathname + path.search, locale, city),
							{
								waitUntil: 'commit',
							},
						);
						expect(response?.ok()).toBe(true);
						await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible();
						if (held) {
							await expect
								.poll(async () => (await (await request.get(fixtureUrl('hold'))).json()).waiting)
								.toBeGreaterThan(0);
						}
						await page.evaluate(() => document.fonts.ready);
						await settled(page);
						if (held && listing) {
							await expect(page.locator('[data-slot="listing-body"]')).toBeVisible();
							await expect(page.locator('[data-slot="listing-search"]')).toBeVisible();
							listingStart = await page.evaluate(() => (window as ShiftWindow).steadyShifts.length);
						}
						if (held) {
							const footerTop = await page
								.getByTestId('footer')
								.evaluate((footer) => footer.getBoundingClientRect().top);
							expect
								.soft(footerTop, 'footer stays below the first viewport while waiting')
								.toBeGreaterThanOrEqual(900);
							const following =
								screen === 'alerts' && width === 1440
									? '#line'
									: screen === 'network-health' && width === 390
										? '#delay'
										: null;
							if (following) {
								const top = await page
									.locator(following)
									.evaluate((node) => node.getBoundingClientRect().top);
								expect
									.soft(
										top,
										`${following} stays below the first viewport while the preceding reading loads`,
									)
									.toBeGreaterThanOrEqual(900);
							}
						}
						const evidence = process.env.TRANSIT_STEADY_EVIDENCE;
						if (
							evidence &&
							held &&
							artwork.has(screen) &&
							city === 'stm' &&
							(width === 390 || width === 1440)
						) {
							await page.screenshot({
								path: join(evidence, `${screen}-${locale}-${width}-waiting.png`),
								animations: 'disabled',
							});
						}
					} finally {
						if (held) expect((await hold('release')).ok()).toBe(true);
					}
					await page.waitForLoadState('domcontentloaded');
					await expect(page.locator('html[data-hydrated]')).toBeAttached();
					await expect(page.locator('main [data-record-pending]')).toHaveCount(0);
					await expect(page.getByRole('contentinfo').getByRole('link').first()).toBeVisible();
					await settled(page);
					const scores = async (phase: string) => {
						const entries = await page.evaluate(() =>
							(window as ShiftWindow).steadyShifts.splice(0),
						);
						const score = entries.reduce((sum, entry) => sum + entry.value, 0);
						await info.attach(`layout-shifts-${phase}`, {
							body: JSON.stringify({ score, entries }),
							contentType: 'application/json',
						});
						if (phase === 'first-screen' && listingStart !== undefined) {
							const arrivals = entries.slice(listingStart);
							expect
								.soft(
									arrivals.reduce((sum, entry) => sum + entry.value, 0),
									`listing shifts when readings arrive: ${JSON.stringify(arrivals)}`,
								)
								.toBe(0);
						}
						expect
							.soft(score, `${phase} shifts: ${JSON.stringify(entries)}`)
							.toBeLessThanOrEqual(0.1);
					};
					await scores('first-screen');
					if (captureRefresh.has(screen) && !(screen === 'alerts-live' && city === 'octranspo')) {
						// The Overview's Live now card refreshes from the summary, the other screens from the capture.
						const liveRead = screen === 'overview' ? liveSummaryUrl : captureUrl;
						const refreshed = page.waitForResponse((reply) => liveRead.test(reply.url()));
						await page.clock.fastForward(30_000);
						expect((await refreshed).ok()).toBe(true);
						await settled(page);
						await scores('refresh');
					}
				});
			}
}

// A vehicle's Live page waits as the not-reporting shape and decides reporting or not before it
// draws its cards; the Vehicles Live head keeps its second line (closing audit G2 M3, S20).
const liveLoads = [
	['en', 390],
	['fr', 768],
	['fr', 1024],
	['en', 1440],
] as const;
for (const city of ['stm', 'octranspo'] as const)
	for (const screen of ['vehicle-reporting', 'vehicle-not-reporting', 'vehicles'] as const)
		for (const [locale, width] of liveLoads)
			test(`${screen} Live ${city} ${locale} ${width}px loads without shifting @layout`, async ({
				page,
			}, info) => {
				await page.setViewportSize({ width, height: 900 });
				await observeShifts(page);
				const { promise: held, resolve: release } = Promise.withResolvers<void>();
				const ottawa = city === 'octranspo' ? { direction_id: null, stop_id: null } : {};
				await page.route(captureUrl, async (route) => {
					await held;
					const at = await page.evaluate(() => Date.now());
					const fleet =
						screen === 'vehicles'
							? Array.from({ length: 30 }, (_, index) =>
									captureVehicle(at, {
										id: `report-${index}`,
										vehicle_id: String(40100 + index),
										...ottawa,
									}),
								)
							: [
									captureVehicle(at, {
										...(screen === 'vehicle-reporting'
											? {}
											: { id: 'report-40099', vehicle_id: '40099' }),
										...ottawa,
									}),
								];
					await route.fulfill({ json: captureFixture(at, { city, vehicle_positions: fleet }) });
				});
				// The trip's predictions and timetable come after the position, as on the live site.
				await page.route(liveTripsUrl, async (route) => {
					await held;
					await new Promise((done) => setTimeout(done, 400));
					const at = await page.evaluate(() => Date.now());
					await route.fulfill({
						json: captureTripReport(city, new Date(at).toISOString(), [
							{
								...captureTrip('T1', '24', [
									{ stop: 'S1', eta_utc: new Date(at + 60_000).toISOString() },
								]),
								direction_id: city === 'stm' ? 1 : null,
							},
						]),
					});
				});
				const path =
					screen === 'vehicles'
						? '/vehicles?frameMode=live'
						: '/vehicle/40061?frameMode=live&recordFrom=2026-11-08&recordTo=2026-11-14';
				const response = await page.goto(localizeHref(path, locale, city), {
					waitUntil: 'commit',
				});
				expect(response?.ok()).toBe(true);
				await expect(page.locator('html[data-hydrated]')).toBeAttached();
				await page.evaluate(() => document.fonts.ready);
				await settled(page);
				const waiting = await page.evaluate(() => (window as ShiftWindow).steadyShifts.length);
				release();
				await expect(page.locator('main [data-record-pending]')).toHaveCount(0);
				if (screen === 'vehicle-reporting')
					await expect(page.locator('[data-slot^="departure-time"]')).toBeVisible();
				await page.waitForTimeout(800);
				await settled(page);
				const shifts = await page.evaluate(() => (window as ShiftWindow).steadyShifts);
				const score = shifts.reduce((sum, { value }) => sum + value, 0);
				await info.attach(`${screen}-live-shifts`, {
					body: JSON.stringify({ score, waiting, shifts }),
					contentType: 'application/json',
				});
				expect(score, JSON.stringify(shifts)).toBeLessThanOrEqual(0.01);
			});

test('steady footer is keyboard reachable after ten seconds while the engine is still held @layout', async ({
	page,
	request,
}) => {
	const port = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';
	const key = `steady:stm:2026-10-13:2026-11-01:${randomUUID()}`;
	const fixture = encodeURIComponent(key);
	const host = `http://127.0.0.1:${port}/__overview`;
	const hold = `${host}/hold?fixture=${fixture}`;
	expect((await request.post(hold)).ok()).toBe(true);
	try {
		await page.setViewportSize({ width: 390, height: 900 });
		await page.setExtraHTTPHeaders({
			'x-transit-fixture-scope': 'alerts',
			'x-transit-fixture-hold': key,
		});
		await page.goto('/alerts?provider=stm&recordFrom=2026-10-13&recordTo=2026-11-01', {
			waitUntil: 'commit',
		});
		await expect
			.poll(async () => (await (await request.get(hold)).json()).waiting)
			.toBeGreaterThan(0);
		const footer = page.getByRole('contentinfo');
		await expect(footer).toHaveCount(0);
		const endTime = await page.getByTestId('footer').evaluate((element) => {
			const [animation] = element.parentElement!.getAnimations();
			return animation?.effect?.getComputedTiming().endTime;
		});
		expect(endTime).toBe(10_000);
		const link = footer.getByRole('link').first();
		await expect(link).toBeVisible({ timeout: 12_000 });
		expect((await (await request.get(hold)).json()).waiting).toBeGreaterThan(0);
		await link.focus();
		await expect(link).toBeFocused();
	} finally {
		expect((await request.post(`${host}/release?fixture=${fixture}`)).ok()).toBe(true);
	}
});

// A departure's answers can arrive after the first paint. The waiting head and cards take the
// answer's size at every width, so the cards under them stay put (closing audit G2 S21).
for (const locale of ['en', 'fr'] as const)
	for (const width of widths) {
		test(`steady departure head and cards ${locale} ${width}px @layout`, async ({
			page,
			request,
		}) => {
			const port = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';
			const fixture = `steady:departure:${locale}:${width}:${randomUUID()}`;
			const fixtureUrl = (action: 'hold' | 'release') =>
				`http://127.0.0.1:${port}/__overview/${action}?fixture=${encodeURIComponent(fixture)}`;
			await page.setViewportSize({ width, height: 900 });
			await page.setExtraHTTPHeaders({ 'x-transit-fixture-hold': fixture });
			await observeShifts(page);
			expect((await request.post(fixtureUrl('hold'))).ok()).toBe(true);
			try {
				await page.goto(
					localizeHref(
						'/departure/24-0-0700?recordFrom=2026-11-16&recordTo=2026-11-20',
						locale,
						'stm',
					),
					{ waitUntil: 'commit' },
				);
				await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible();
				await expect
					.poll(async () => (await (await request.get(fixtureUrl('hold'))).json()).waiting)
					.toBeGreaterThan(0);
				await page.evaluate(() => document.fonts.ready);
				await settled(page);
				const before = await page.evaluate(() => (window as ShiftWindow).steadyShifts.length);
				expect((await request.post(fixtureUrl('release'))).ok()).toBe(true);
				await expect(page.locator('#delay [data-record-pending]')).toHaveCount(0);
				await expect(page.locator('#stops [data-record-pending]')).toHaveCount(0);
				await settled(page);
				const shifts = (await page.evaluate(() => (window as ShiftWindow).steadyShifts)).slice(
					before,
				);
				const score = shifts.reduce((sum, { value }) => sum + value, 0);
				expect(score, `departure shifts: ${JSON.stringify(shifts)}`).toBeLessThanOrEqual(0.01);
			} finally {
				await request.post(fixtureUrl('release'));
			}
		});
	}
