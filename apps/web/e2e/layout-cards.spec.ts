import { createHash } from 'node:crypto';
import closedWindows from '../scripts/__fixtures__/b9/layout-windows.json' with { type: 'json' };
import { test } from './layout-test';
import { expect, type Page, type Request as PlaywrightRequest } from '@playwright/test';
import { localizeHref } from '../src/lib/i18n/routing';

for (const provider of ['stm', 'octranspo'])
	for (const locale of ['en', 'fr'] as const)
		for (const path of ['/lines', '/search?q=24'])
			test(`${provider} ${locale} ${path} card container rules`, async ({ page }) => {
				await page.clock.setFixedTime(Date.parse('2026-06-15T12:00:30Z'));
				await page.route('**/v1/**', async (route) => {
					const url = new URL(route.request().url());
					url.pathname = `/__layout/fresh${url.pathname.replace('/octranspo/', '/stm/')}`;
					const response = await route.fetch({ url: url.href });
					if (url.pathname.endsWith('route_reliability/index.json')) {
						await route.fulfill({
							json: { generated_utc: '2026-06-15T12:00:00Z', route_ids: ['24'] },
						});
					} else if (url.pathname.endsWith('/route_reliability/24.json')) {
						const body = await response.json();
						for (const period of body.periods)
							Object.assign(period, {
								otp_pct: 95,
								observation_count: 1000,
								on_time: 950,
								wilson_lo: 92,
								wilson_hi: 98,
							});
						Object.assign(body, closedWindows.ready.line);
						await route.fulfill({ response, json: body });
					} else if (url.pathname.endsWith('routes_index.json')) {
						const body = await response.json();
						body.routes = Array.from({ length: 6 }, (_, i) => ({
							...body.routes[0],
							id: i === 0 ? '24' : `24${i}`,
							short: i === 0 ? '24' : `24${i}`,
						}));
						await route.fulfill({ response, json: body });
					} else await route.fulfill({ response });
				});
				await page.goto(
					localizeHref(`${path}${path.includes('?') ? '&' : '?'}provider=${provider}`, locale),
					{ waitUntil: 'networkidle' },
				);
				const list = page.locator('[data-slot="entity-list"]').first();
				await expect(list).toBeVisible();
				const reading = path === '/lines';
				const row = list.locator('[data-slot="entity-result-row"]').first();
				if (reading) {
					// The Lines directory is one card of aligned rows, never a card grid.
					await expect(list.locator('[data-slot="card"]')).toHaveCount(0);
					expect(await row.evaluate((el) => (el.closest('[data-slot="card"]') ? 1 : 0))).toBe(1);
					// The same three widths exercise the row itself: wide, stacked, and phone.
					for (const [width, stacked] of [
						[743, false],
						[470, false],
						[320, true],
					] as const) {
						await list.evaluate((el, next) => {
							el.parentElement!.style.width = `${next}px`;
						}, width);
						await row.scrollIntoViewIfNeeded();
						const status = row.locator('[data-slot="entity-result-status"]');
						await expect(status).toBeVisible();
						await expect(status.locator('[data-slot="reliability-badge"]')).toContainText('95');
						expect(
							await row.evaluate((element) => {
								const name = element.querySelector('.readable-name') as HTMLElement;
								const evidence = element.querySelector(
									'[data-slot="entity-result-status"]',
								) as HTMLElement;
								const action = element.querySelector(
									'[data-slot="entity-result-action"]',
								) as HTMLElement;
								const box = element.getBoundingClientRect();
								const problems: string[] = [];
								if (name.scrollWidth > name.clientWidth + 1) problems.push('name clipped');
								if (getComputedStyle(name).wordBreak === 'break-all')
									problems.push('word shredded');
								for (const node of [name, evidence, action]) {
									const rect = node.getBoundingClientRect();
									if (rect.left < box.left - 1 || rect.right > box.right + 1)
										problems.push('outside row');
								}
								const overlaps = (a: DOMRect, b: DOMRect) =>
									a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
								if (overlaps(name.getBoundingClientRect(), evidence.getBoundingClientRect()))
									problems.push('name overlaps evidence');
								if (overlaps(name.getBoundingClientRect(), action.getBoundingClientRect()))
									problems.push('name overlaps action');
								if (name.getBoundingClientRect().height < 44) problems.push('small name target');
								if (action.getBoundingClientRect().height < 44)
									problems.push('small action target');
								return problems;
							}),
						).toEqual([]);
						await expect
							.poll(async () => {
								const main = await row.locator('[data-slot="entity-result-main"]').boundingBox();
								const badge = await status.boundingBox();
								return badge!.y >= main!.y + main!.height;
							})
							.toBe(stacked);
					}
				} else {
					// The same viewport exercises both sides of each container boundary.
					for (const [width, columns] of [
						[743, 1],
						[744, 2],
						[1127, 2],
						[1128, 3],
					]) {
						await list.evaluate((el, width) => {
							el.parentElement!.style.width = `${width}px`;
						}, width);
						await expect
							.poll(() =>
								list.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length),
							)
							.toBe(columns);
					}
					for (const [width, stacked] of [
						[470, false],
						[420, true],
					] as const) {
						await list.evaluate((el, width) => {
							el.parentElement!.style.width = `${width}px`;
						}, width);
						await row.scrollIntoViewIfNeeded();
						const status = row.locator('[data-slot="entity-result-status"]');
						await expect(status).toBeVisible();
						await expect(status.locator('[data-slot="reliability-badge"]')).toContainText('95');
						await expect
							.poll(async () => {
								const main = await row.locator('[data-slot="entity-result-main"]').boundingBox();
								const badge = await status.boundingBox();
								return badge!.y >= main!.y + main!.height;
							})
							.toBe(stacked);
					}
				}
			});

function brokenStatusWords(element: Element) {
	const status = element.querySelector('[data-slot="entity-result-status"]');
	if (!status) return [];
	const words: string[] = [];
	const bounds = element.getBoundingClientRect();
	const walker = document.createTreeWalker(status, NodeFilter.SHOW_TEXT);
	while (walker.nextNode()) {
		const node = walker.currentNode;
		for (const match of node.textContent!.matchAll(/\S+/g)) {
			const range = document.createRange();
			range.setStart(node, match.index!);
			range.setEnd(node, match.index! + match[0].length);
			if (
				new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size > 1 ||
				[...range.getClientRects()].some((r) => r.left < bounds.left || r.right > bounds.right + 1)
			)
				words.push(match[0]);
		}
	}
	return words;
}
async function holdReliability(page: Page) {
	const entityFile = '/route_reliability/24.json';
	const gate = {
		holding: true,
		state: 'ready',
		entered: (_request: PlaywrightRequest) => {},
		releases: [] as Array<() => void>,
	};
	await page.route('**/v1/**', async (route) => {
		const entered = gate.entered;
		const state = gate.state;
		const url = new URL(route.request().url());
		url.pathname = '/__layout/fresh' + url.pathname;
		const response = await route.fetch({ url: url.href });
		if (url.pathname.endsWith('/historic' + entityFile)) {
			entered(route.request());
			if (gate.holding)
				await new Promise<void>((resolve) => {
					gate.releases.push(resolve);
				});
			if (state === 'empty') {
				await route.fulfill({
					status: 404,
					json: {},
					headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
				});
				return;
			}
			const body = await response.json();
			Object.assign(
				body,
				closedWindows[state === 'low-sample' ? 'low-sample' : state === 'hedge' ? 'hedge' : 'ready']
					.line,
			);
			await route.fulfill({ response, json: body });
		} else await route.fulfill({ response });
	});
	return gate;
}
for (const locale of ['en', 'fr'] as const)
	for (const path of ['/lines'])
		for (const width of [320, 360, 390])
			test(`${locale} ${path} ${width} reliability arrival keeps row height and whole words`, async ({
				page,
			}) => {
				const gate = await holdReliability(page);
				await page.addInitScript(() => {
					const state = window as typeof window & {
						__transitReliabilityTestSettledFetches: string[];
					};
					state.__transitReliabilityTestSettledFetches = [];
					const nativeFetch = window.fetch;
					window.fetch = async (...args) => {
						try {
							return await nativeFetch(...args);
						} finally {
							const input = args[0];
							state.__transitReliabilityTestSettledFetches.push(
								typeof input === 'string'
									? input
									: input instanceof Request
										? input.url
										: String(input),
							);
						}
					};
				});
				try {
					await page.setViewportSize({ width, height: 900 });
					let readyHeight: number | undefined;
					for (const state of ['ready', 'hedge', 'low-sample', 'empty']) {
						gate.state = state;
						gate.holding = true;
						const pending = new Promise<PlaywrightRequest>((resolve) => {
							gate.entered = resolve;
						});
						await page.goto(localizeHref('/lines?provider=stm', locale), {
							waitUntil: 'domcontentloaded',
						});
						const entityPath = localizeHref('/lines/24', locale);
						const row = page
							.locator('[data-slot="entity-result-row"]')
							.filter({ has: page.locator(`a[href^="${entityPath}?"]`) })
							.first();
						await row.scrollIntoViewIfNeeded();
						const request = await pending;
						const delivered = page.waitForResponse((response) => response.request() === request);
						await page.evaluate(() => document.fonts.ready);
						const before = (await row.boundingBox())!.height;
						gate.holding = false;
						for (const release of gate.releases.splice(0)) release();
						const response = await delivered;
						if (state !== 'empty') await response.finished();
						expect(response.status()).toBe(state === 'empty' ? 404 : 200);
						if (state === 'empty') {
							await page.waitForFunction(
								(file) =>
									(
										window as typeof window & { __transitReliabilityTestSettledFetches: string[] }
									).__transitReliabilityTestSettledFetches.some((url) => url.includes(file)),
								'/route_reliability/24.json',
							);
							await expect(row.locator('[data-slot="entity-result-status"]')).toHaveCount(0);
						} else
							await expect(
								row.locator(
									state === 'hedge' || state === 'low-sample'
										? '[data-slot="reliability-hedge"]'
										: '[data-slot="reliability-badge"]',
								),
							).toBeVisible();
						if (state === 'low-sample')
							await expect(row.locator('[data-slot="reliability-hedge"]')).toContainText(
								locale === 'fr' ? /Données insuffisantes/ : /Not enough data/,
							);
						const after = (await row.boundingBox())!.height;
						expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
						if (state === 'ready') readyHeight = after;
						expect(after).toBeLessThanOrEqual(readyHeight! + 1);
						expect(await row.evaluate(brokenStatusWords)).toEqual([]);
					}
				} finally {
					gate.holding = false;
					for (const release of gate.releases.splice(0)) release();
				}
			});

// Shown (30 of 40, 40 of 80) and held (29 of 40, 40 of 81) live on-time shares, across both floors.
const liveShares = [
	[40, 30],
	[40, 29],
	[80, 40],
	[81, 40],
] as const;
for (const locale of ['en', 'fr'] as const)
	for (const [path, block, next, figure] of [
		[
			'/network',
			'[data-network-section="network-live-headline"]',
			'[data-network-section="network-reporting"]',
			'[data-network-section="network-live-headline"] [data-slot="metric-display"] >> nth=0',
		],
	] as const)
		test(`${locale} ${path} live on-time share keeps one size shown or held`, async ({ page }) => {
			await page.clock.setFixedTime(Date.parse('2026-06-15T12:00:30Z'));
			let live: { inService: number; readings: number } = { inService: 40, readings: 30 };
			await page.route('**/v1/**', async (route) => {
				const url = new URL(route.request().url());
				url.pathname = `/__layout/fresh${url.pathname}`;
				const response = await route.fetch({ url: url.href });
				if (!url.pathname.endsWith('/live/network.json')) return route.fulfill({ response });
				const body = await response.json();
				const known = live.readings;
				Object.assign(body, {
					vehicles_in_service: live.inService,
					on_time_pct: 75,
					coverage_pct: Math.round((100 * known) / live.inService),
					status_dist: {
						early: 1,
						on_time: known - 9,
						late: 6,
						severe: 2,
						unknown: live.inService - known,
					},
				});
				await route.fulfill({ response, json: body });
			});
			// This spec owns its widths: two phones and the desktop grid.
			for (const width of [320, 390, 1440]) {
				await page.setViewportSize({ width, height: 900 });
				const sizes = [];
				for (const [inService, readings] of liveShares) {
					live = { inService, readings };
					await page.goto(`${localizeHref(path, locale)}?provider=stm`, {
						waitUntil: 'networkidle',
					});
					const held = readings < 30 || readings * 2 < inService;
					// Inner text only: the held wording's hidden reserve must not satisfy the wait.
					await expect(page.locator(figure).first()).toContainText(
						held ? (locale === 'en' ? 'Not enough readings' : 'Pas assez de relevés') : '75',
						{ useInnerText: true },
					);
					await page.evaluate(() => document.fonts.ready);
					sizes.push(
						await page.evaluate(
							([block, next]) => {
								const top = (selector: string) =>
									document.querySelector(selector)!.getBoundingClientRect().top + window.scrollY;
								return {
									height: document.querySelector(block)!.getBoundingClientRect().height,
									next: top(next),
								};
							},
							[block, next],
						),
					);
				}
				for (const [i, size] of sizes.entries()) {
					const at = `${width}px, ${liveShares[i].join(' in service, ')} readings`;
					expect(Math.abs(size.height - sizes[0].height), `${at}: headline height`).toBeLessThan(
						0.5,
					);
					expect(Math.abs(size.next - sizes[0].next), `${at}: content below`).toBeLessThan(0.5);
				}
			}
		});

// A ranked week with full-length names, a 30-reading-floor example and seven rows.
const hotspotsWeek = {
	generated_utc: '2026-06-15T12:00:00Z',
	methodology_version: 'r2',
	by_grain: [
		{
			grain: 'week',
			date: '2026-06-08',
			window_end: '2026-06-14',
			entries: [
				...Array.from({ length: 7 }, (_, i) => ({
					rank: i + 1,
					type: 'route',
					id: i === 0 ? '24' : `24${i}`,
					name: 'Bayshore / Carlingwood <> Dunrobin / Carp / Stittsville / Place d’Orléans',
					observation_count: 1000 + i,
					severe_count: 900 - 10 * i,
					severe_pct: Math.round((1000 * (900 - 10 * i)) / (1000 + i)) / 10,
					wilson_lo: 5 * (i + 1),
					wilson_hi: 5 * (i + 1) + 10,
				})),
				{
					rank: 1,
					type: 'stop',
					id: '52095',
					name: 'Station Berri-UQAM / Sainte-Catherine Est (côté nord)',
					observation_count: 64,
					severe_count: 60,
					severe_pct: 93.8,
				},
			],
			tray: [{ type: 'stop', id: '5581', name: 'Doctor Leach / Ad. 5581', observation_count: 2 }],
			total_ranked_routes: 173,
			total_ranked_stops: 4930,
			tray_total: 1,
		},
	],
};

/** Sorted keys, no spaces: the publisher's canonical JSON for generation ids. */
function canonical(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
		.join(',')}}`;
}
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** A real retained-history state: the root advertises one retained day, its index and file. */
function retainedHistory(
	family: 'hotspots' | 'repeat_offenders',
	day: string,
	date: string,
	root: { families?: unknown[] },
	provider: string,
) {
	const ref = {
		path: `historic/history/${family}/generations/${sha256(day)}/${date}.json`,
		coverage_start: date,
		coverage_end: date,
		count: 1,
		sha256: sha256(day),
		byte_size: Buffer.byteLength(day),
	};
	const basis = {
		family,
		selection_mode: 'date',
		entity_id: null,
		first_available_date: date,
		last_available_date: date,
		available_dates: [date],
		gaps: [],
		partitions: [ref],
		metrics: [],
	};
	const generation = sha256(canonical(basis));
	const index = JSON.stringify({
		...basis,
		generated_utc: '2026-06-15T12:00:00Z',
		collection_generation_id: generation,
		methodology_version: 'history-1',
		// Publications name their provider.
		publish_generation_id: `${provider}@published-run`,
	});
	// The root points at a generation-pinned index whose bytes hash to the path's SHA-256.
	const indexPath = `historic/history/${family}/generations/${sha256(index)}/index.json`;
	const edge = {
		family,
		selection_mode: 'date',
		index_path: indexPath,
		collection_generation_id: generation,
		first_available_date: date,
		last_available_date: date,
		gaps: [],
		metrics: [],
	};
	return {
		root: { ...root, families: [...(root.families ?? []), edge] },
		index,
		indexPath,
		day,
		ref,
	};
}

function hotspotsHistory(root: { families?: unknown[] }, provider: string) {
	const date = '2026-06-14';
	const day = JSON.stringify({ ...hotspotsWeek, date, publish_generation_id: null });
	return retainedHistory('hotspots', day, date, root, provider);
}

type Sampled = Window & { samples?: string[] };

for (const provider of ['stm', 'octranspo'])
	for (const locale of ['en', 'fr'] as const)
		test(`${provider} ${locale} hotspots keep 7 + 5 with history, whole names and 44 px targets`, async ({
			page,
		}) => {
			await page.clock.setFixedTime(Date.parse('2026-06-15T12:00:30Z'));
			let discover = (): void => {};
			const discovery = new Promise<void>((resolve) => (discover = resolve));
			let history: ReturnType<typeof hotspotsHistory> | null = null;
			await page.route('**/v1/**', async (route) => {
				const url = new URL(route.request().url());
				const path = url.pathname.replace('/octranspo/', '/stm/');
				if (path.endsWith('/historic/hotspots.json')) return route.fulfill({ json: hotspotsWeek });
				if (history && path.endsWith(history.indexPath)) {
					await discovery;
					return route.fulfill({ body: history.index, contentType: 'application/json' });
				}
				if (history && path.endsWith(history.ref.path))
					return route.fulfill({ body: history.day, contentType: 'application/json' });
				url.pathname = `/__layout/fresh${path}`;
				const response = await route.fetch({ url: url.href });
				if (!path.endsWith('/historic/history/index.json')) return route.fulfill({ response });
				history = hotspotsHistory(await response.json(), provider);
				await route.fulfill({ response, json: history.root });
			});
			await page.setViewportSize({ width: 1280, height: 900 });
			await page.goto(`${localizeHref('/hotspots', locale)}?provider=${provider}`);
			const rows = page.locator('[data-slot="hotspot-rows"] > li > button');
			const controls = page.locator('[data-slot="hotspots-controls"]');
			const navigator = controls.locator('[data-slot="history-navigator"]');
			await expect(controls).toBeVisible();
			// The ranking waits for history discovery, so discovery cannot move it afterwards.
			await page.waitForTimeout(500);
			await expect(rows).toHaveCount(0);
			await page.evaluate(() => {
				const samples: string[] = [];
				(window as Sampled).samples = samples;
				const sample = () => {
					const frame = document.querySelector('.hotspots-workspace-frame');
					if (frame) {
						const box = frame.getBoundingClientRect();
						samples.push(`${box.top + window.scrollY}:${box.left}:${box.width}`);
					}
					if (samples.length < 60) requestAnimationFrame(sample);
				};
				requestAnimationFrame(sample);
			});
			discover();
			await expect(rows).toHaveCount(7);
			await expect(navigator).toBeVisible();
			await page.waitForFunction(() => ((window as Sampled).samples ?? []).length >= 60);
			const samples = await page.evaluate(() => (window as Sampled).samples ?? []);
			expect(new Set(samples).size, 'workspace once shown').toBe(1);

			// This spec owns its widths: the desktop split, a tablet and the two phones.
			for (const width of [1280, 768, 390, 320]) {
				await page.setViewportSize({ width, height: 900 });
				await page.evaluate(() => document.fonts.ready);
				const at = `${provider} ${locale} ${width}px`;
				await expect(navigator, `${at}: history control`).toBeVisible();
				expect(
					await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
					`${at}: no page-wide horizontal scroll`,
				).toBe(true);
				for (const row of await rows.all()) {
					const box = (await row.boundingBox())!;
					expect(box.height, `${at}: row target`).toBeGreaterThanOrEqual(44);
					expect(box.x + box.width, `${at}: row inside the viewport`).toBeLessThanOrEqual(width);
					const rate = (await row.locator('[data-slot="ranking-rate"]').boundingBox())!;
					expect(rate.x + rate.width, `${at}: rate inside its row`).toBeLessThanOrEqual(
						box.x + box.width + 0.5,
					);
					expect(
						await row
							.locator('[data-slot="hotspot-row-name"]')
							.evaluate((name) => name.scrollWidth <= name.clientWidth + 1),
						`${at}: whole name`,
					).toBe(true);
				}
				const pane = page.locator('[data-slot="hotspot-evidence-pane"]');
				if (width >= 1280) {
					await expect(pane, `${at}: 7 + 5 side pane`).toBeVisible();
					await rows.nth(2).click();
					await expect(rows.nth(2)).toHaveAttribute('aria-pressed', 'true');
					await expect(pane).toContainText(
						locale === 'en' ? 'Position 3 of 173' : 'Position 3 sur 173',
					);
					continue;
				}
				await expect(pane, `${at}: no side pane`).toBeHidden();
				const first = rows.first();
				await expect(first).toHaveAttribute('aria-expanded', /true|false/);
				if ((await first.getAttribute('aria-expanded')) === 'false') await first.click();
				const evidence = page.locator('[data-slot="hotspot-row-evidence"]:not([hidden])');
				await expect(evidence).toBeVisible();
				for (const action of await evidence.locator('a, button').all()) {
					const box = (await action.boundingBox())!;
					expect(box.height, `${at}: evidence action target`).toBeGreaterThanOrEqual(44);
					expect(box.x + box.width, `${at}: evidence action inside`).toBeLessThanOrEqual(width);
				}
			}
		});

const OFFENDER_LINE = 'Bayshore / Carlingwood <> Dunrobin / Carp / Stittsville / Place d’Orléans';
const offenderShare = (late: number, readings: number) => Math.round((1000 * late) / readings) / 10;
/** One trip or bus row as the #1080 publisher writes it, with its bounds around the share. */
function offender(type: 'trip' | 'vehicle', rank: number | null, i: number) {
	const readings = 90 + i;
	const pct = offenderShare(60, readings);
	return {
		rank,
		type,
		id: type === 'trip' ? `30218194${i}` : `46${70 + i}`,
		route: '24',
		route_name: OFFENDER_LINE,
		...(type === 'trip'
			? {
					route_short_name: '24',
					departure_time: `${7 + i}:42:00`,
					headsign: 'Carlingwood <> Dunrobin / Carp / Stittsville',
				}
			: {}),
		observation_count: readings,
		severe_count: 60,
		severe_pct: pct,
		wilson_lo: Math.max(0, Math.round((100 - pct - 8) * 10) / 10),
		wilson_hi: Math.min(100, Math.round((100 - pct + 8) * 10) / 10),
		recurrence_days: rank == null ? 1 : 6 - Math.floor(i / 2),
		observed_days: rank == null ? 1 : 6,
		window_days: 7,
		avg_delay_min: 20 - i,
	};
}
// A ranked week with full-length line names and departures, two buses and one row below the rule.
const offendersWeek = {
	generated_utc: '2026-06-15T12:00:00Z',
	methodology_version: 'reliability-2',
	by_grain: [
		{
			grain: 'week',
			window_days: 7,
			entries: [
				...Array.from({ length: 7 }, (_, i) => offender('trip', i + 1, i)),
				offender('vehicle', 1, 0),
				offender('vehicle', 2, 1),
			],
			tray: [offender('trip', null, 9)],
			total_ranked_trips: 120,
			total_ranked_vehicles: 41,
			tray_total: 1,
		},
	],
};

function offendersHistory(root: { families?: unknown[] }, provider: string) {
	const date = '2026-06-14';
	const day = JSON.stringify({
		...offendersWeek,
		date,
		publish_generation_id: null,
		by_grain: offendersWeek.by_grain.map((grain) => ({
			...grain,
			date: '2026-06-08',
			window_end: date,
		})),
	});
	return retainedHistory('repeat_offenders', day, date, root, provider);
}

for (const provider of ['stm', 'octranspo'])
	for (const locale of ['en', 'fr'] as const)
		test(`${provider} ${locale} repeat offenders keep 7 + 5 with history, whole names and 44 px targets`, async ({
			page,
		}) => {
			await page.clock.setFixedTime(Date.parse('2026-06-15T12:00:30Z'));
			let discover = (): void => {};
			const discovery = new Promise<void>((resolve) => (discover = resolve));
			let history: ReturnType<typeof offendersHistory> | null = null;
			await page.route('**/v1/**', async (route) => {
				const url = new URL(route.request().url());
				const path = url.pathname.replace('/octranspo/', '/stm/');
				if (path.endsWith('/historic/repeat_offenders.json'))
					return route.fulfill({ json: offendersWeek });
				if (history && path.endsWith(history.indexPath)) {
					await discovery;
					return route.fulfill({ body: history.index, contentType: 'application/json' });
				}
				if (history && path.endsWith(history.ref.path))
					return route.fulfill({ body: history.day, contentType: 'application/json' });
				url.pathname = `/__layout/fresh${path}`;
				const response = await route.fetch({ url: url.href });
				if (!path.endsWith('/historic/history/index.json')) return route.fulfill({ response });
				history = offendersHistory(await response.json(), provider);
				await route.fulfill({ response, json: history.root });
			});
			await page.setViewportSize({ width: 1280, height: 900 });
			await page.goto(`${localizeHref('/repeat-offenders', locale)}?provider=${provider}`);
			const rows = page.locator('[data-slot="offender-rows"] > li > button');
			const controls = page.locator('[data-slot="offenders-controls"]');
			const navigator = controls.locator('[data-slot="history-navigator"]');
			await expect(controls).toBeVisible();
			// The ranking waits for history discovery, so discovery cannot move it afterwards.
			await page.waitForTimeout(500);
			await expect(rows).toHaveCount(0);
			await page.evaluate(() => {
				const samples: string[] = [];
				(window as Sampled).samples = samples;
				const sample = () => {
					const frame = document.querySelector('.offenders-workspace-frame');
					if (frame) {
						const box = frame.getBoundingClientRect();
						samples.push(`${box.top + window.scrollY}:${box.left}:${box.width}`);
					}
					if (samples.length < 60) requestAnimationFrame(sample);
				};
				requestAnimationFrame(sample);
			});
			discover();
			await expect(rows).toHaveCount(7);
			await expect(navigator).toBeVisible();
			await page.waitForFunction(() => ((window as Sampled).samples ?? []).length >= 60);
			const samples = await page.evaluate(() => (window as Sampled).samples ?? []);
			expect(new Set(samples).size, 'workspace once shown').toBe(1);

			// This spec owns its widths: the desktop split, a tablet and the two phones.
			for (const width of [1280, 768, 390, 320]) {
				await page.setViewportSize({ width, height: 900 });
				await page.evaluate(() => document.fonts.ready);
				const at = `${provider} ${locale} ${width}px`;
				await expect(navigator, `${at}: history control`).toBeVisible();
				expect(
					await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
					`${at}: no page-wide horizontal scroll`,
				).toBe(true);
				for (const row of await rows.all()) {
					const box = (await row.boundingBox())!;
					expect(box.height, `${at}: row target`).toBeGreaterThanOrEqual(44);
					expect(box.x + box.width, `${at}: row inside the viewport`).toBeLessThanOrEqual(width);
					const late = (await row.locator('[data-slot="ranking-rate"]').boundingBox())!;
					expect(late.x + late.width, `${at}: late days inside their row`).toBeLessThanOrEqual(
						box.x + box.width + 0.5,
					);
					for (const slot of ['offender-row-name', 'offender-row-line'])
						expect(
							await row
								.locator(`[data-slot="${slot}"]`)
								.evaluate((name) => name.scrollWidth <= name.clientWidth + 1),
							`${at}: whole ${slot}`,
						).toBe(true);
				}
				const pane = page.locator('[data-slot="offender-evidence-pane"]');
				if (width >= 1280) {
					await expect(pane, `${at}: 7 + 5 side pane`).toBeVisible();
					await rows.nth(2).click();
					await expect(rows.nth(2)).toHaveAttribute('aria-pressed', 'true');
					await expect(pane).toContainText(
						locale === 'en' ? 'Position 3 of 120' : 'Position 3 sur 120',
					);
					continue;
				}
				await expect(pane, `${at}: no side pane`).toBeHidden();
				const first = rows.first();
				await expect(first).toHaveAttribute('aria-expanded', /true|false/);
				if ((await first.getAttribute('aria-expanded')) === 'false') await first.click();
				const evidence = page.locator('[data-slot="offender-row-evidence"]:not([hidden])');
				await expect(evidence).toBeVisible();
				for (const action of await evidence.locator('a, button').all()) {
					const box = (await action.boundingBox())!;
					expect(box.height, `${at}: evidence action target`).toBeGreaterThanOrEqual(44);
					expect(box.x + box.width, `${at}: evidence action inside`).toBeLessThanOrEqual(width);
				}
			}
		});
