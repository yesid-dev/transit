import { expect, test, type Locator, type Page } from '@playwright/test';

import { detailCopy } from '../src/lib/features/stops/stops.copy';
import { PUBLISHED_LOCALES } from '../src/lib/i18n/config';
import { localizeHref } from '../src/lib/i18n/routing';
import { captureTrip, captureTripReport } from './capture-fixture';

const base = Date.parse('2026-06-15T12:00:00Z');
const at = (seconds: number) => new Date(base + seconds * 1000).toISOString();
const dataURL = `http://127.0.0.1:${process.env.TRANSIT_E2E_DATA_PORT ?? '4318'}`;

test.use({ bypassCSP: true });

test.beforeEach(async ({ page }) => {
	await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
	await page.clock.setFixedTime(base + 30_000);
});

/** Serve this stop report to the browser, released when the test says so. */
async function serveDepartures(page: Page, body: () => unknown) {
	let release: () => void = () => {};
	let ready = new Promise<void>((resolve) => (release = resolve));
	await page.route('**/api/live-trips?city=stm&stop=T6-HUB', async (route) => {
		await ready;
		await route.fulfill({ json: body() });
	});
	return {
		hold() {
			ready = new Promise<void>((resolve) => (release = resolve));
		},
		release: () => release(),
	};
}

/** Overflow, small targets and words broken inside, measured in the page. */
function layoutDefects(root: Locator) {
	return root.evaluate((element) => {
		const viewport = document.documentElement.clientWidth;
		const bad: string[] = [];
		for (const node of element.querySelectorAll('a,select,button,th,td,h3 span')) {
			const rect = node.getBoundingClientRect();
			if (!rect.width || !rect.height) continue;
			if (rect.left < -1 || rect.right > viewport + 1)
				bad.push(`overflow: ${node.textContent} ${rect.left},${rect.right}`);
			if (node.matches('a,select,button') && rect.height < 44)
				bad.push(`target: ${node.textContent} ${rect.height}`);
			const table = node.closest('table');
			if (table && rect.right > table.parentElement!.getBoundingClientRect().right + 1)
				bad.push(`table overflow: ${node.textContent}`);
			const range = document.createRange();
			const lineHeight = Number.parseFloat(getComputedStyle(node).lineHeight) || rect.height;
			for (const child of node.childNodes) {
				if (child.nodeType !== Node.TEXT_NODE) continue;
				// A compound name may wrap after its hyphen; a break inside a word may not.
				for (const match of (child.textContent ?? '').matchAll(/[^\s-]+-?/g)) {
					range.setStart(child, match.index!);
					range.setEnd(child, match.index! + match[0].length);
					if (range.getBoundingClientRect().height > lineHeight * 1.5)
						bad.push(`broken word: ${match[0]}`);
				}
			}
			if (getComputedStyle(node).wordBreak === 'break-all')
				bad.push(`break-all: ${node.textContent}`);
		}
		return bad;
	});
}

for (const locale of PUBLISHED_LOCALES) {
	const t = detailCopy[locale];
	const live = t.live;
	const panelOf = (page: Page) => page.getByRole('tabpanel', { name: t.tabs.detail, exact: true });

	test(`${locale}: a 12-line hub's predictions stay grouped and readable at 320 to 1280`, async ({
		page,
	}, testInfo) => {
		const hub = (await (await fetch(`${dataURL}/v1/stm/static/stops/T6-HUB.json`)).json()) as {
			routes_served: string[];
		};
		const delays = [-3, -1, 0, 1, 2, 5, 6, null];
		const report = {
			generated_utc: at(0),
			feed_captured_utc: at(0),
			stops: {
				'T6-HUB': hub.routes_served.flatMap((route, i) =>
					[0, 1].map((n) => ({
						route,
						trip: `t6-${route}-${n}`,
						// Line order by time differs from line order by number.
						eta_utc: at(60 * (((i * 7) % 12) + 2 + 9 * n)),
						delay_min: delays[(2 * i + n) % delays.length],
					})),
				),
			},
		};
		const feed = await serveDepartures(page, () =>
			captureTripReport(
				'stm',
				report.generated_utc,
				report.stops['T6-HUB'].map((row) => ({
					...captureTrip(row.trip, row.route, [{ ...row, stop: 'T6-HUB' }]),
					direction_id: 0,
					start_time: '07:00:00',
				})),
			),
		);
		for (const width of [320, 390, 768, 1280]) {
			await page.setViewportSize({ width, height: 900 });
			feed.hold();
			// A blank page between widths, so the browser restores no scroll position.
			await page.goto('about:blank');
			await page.goto(localizeHref('/stop/T6-HUB?tab=detail', locale, 'stm'));
			const panel = panelOf(page);
			const header = page.locator('[data-slot="article-header"]');
			const lead = panel.locator('[data-slot="stop-summary"]');
			await expect(lead).toBeVisible();
			const place = () =>
				Promise.all(
					[header, lead].map((box) =>
						box.evaluate((element) => {
							const rect = element.getBoundingClientRect();
							return [rect.top + window.scrollY, rect.height];
						}),
					),
				);
			const before = await place();
			feed.release();
			const list = panel.locator('[data-slot="stop-live-predictions"]');
			await expect(list.getByRole('table')).toHaveCount(12);
			// Nothing above the predictions moves when the report arrives.
			expect(await place()).toEqual(before);
			await expect(list.locator('tbody tr')).toHaveCount(24);
			await expect(list.getByText(live.total(24, 12))).toBeVisible();
			const headings = list.getByRole('heading', { level: 3 });
			await expect(headings.first()).toContainText(hub.routes_served[0]!);
			await expect(list.getByRole('link', { name: new RegExp(live.trip) })).toHaveCount(24);
			// Capture predictions supply seconds. Both inclusive limits belong to the on-time band.
			const statusCells = list.locator('td.stop-live__status');
			for (const [band, minutes] of [
				['early', [-3]],
				['on_time', [-1, 0, 1, 2, 5]],
				['late', [6]],
			] as const) {
				const seeded = report.stops['T6-HUB'].filter((row) =>
					minutes.some((minute) => minute === row.delay_min),
				).length;
				const matching = statusCells.locator(`[data-bands="${band}"]`);
				await expect(matching).toHaveCount(seeded);
				await expect(matching.first()).toContainText(live.bands[band]);
			}
			await expect(statusCells.locator('[data-slot="absent-value"]')).toHaveCount(
				report.stops['T6-HUB'].filter((row) => row.delay_min == null).length,
			);
			if (width === 320 || width === 1280) {
				await panel.locator('[data-toc="stop-detail-departures"]').screenshot({
					path: testInfo.outputPath(`stop-live-${locale}-${width}.png`),
				});
			}
			await expect(headings.last()).toContainText('129');
			await list.getByRole('combobox', { name: live.order }).selectOption('line');
			await expect(headings.first()).toContainText(/^\D*24\b/);
			await expect(headings.last()).toContainText('747');
			expect(await layoutDefects(panel), `${locale} ${width}`).toEqual([]);
			await expect(panel.getByRole('link', { name: live.record, exact: true })).toHaveAttribute(
				'href',
				/\/stop\/T6-HUB(?:[?]|$)/,
			);
			await expect(page.locator('html')).toHaveJSProperty('scrollWidth', width);
		}
	});

	test(`${locale}: each absence says what it is, with no order control`, async ({ page }) => {
		let reportedAt: string | null = at(0);
		await page.route('**/api/live-trips?city=stm&stop=*', (route) =>
			reportedAt == null
				? route.abort()
				: route.fulfill({ json: captureTripReport('stm', reportedAt, []) }),
		);
		const cases: [string, string, RegExp | string, boolean][] = [
			['T6-METRO', at(0), live.noCapability, false],
			['T6-NONE', at(0), live.noService, true],
			['T6-HUB', at(0), live.none, true],
			['T6-HUB', at(-600), live.staleNone, true],
		];
		for (const width of [320, 1280]) {
			await page.setViewportSize({ width, height: 900 });
			for (const [stop, timestamp, sentence, stamped] of cases) {
				reportedAt = timestamp;
				await page.goto(localizeHref(`/stop/${stop}?tab=detail`, locale, 'stm'));
				const panel = panelOf(page);
				await expect(panel.getByTestId('stop-live-state')).toContainText(sentence);
				await expect(panel.locator('[data-slot="stop-live-predictions"]')).toHaveCount(0);
				await expect(panel.getByRole('combobox')).toHaveCount(0);
				await expect(
					panel.locator('.stop-report[data-source="departures"] [data-slot="freshness-stamp"]'),
				).toHaveCount(stamped ? 1 : 0);
				await expect(panel.getByRole('link', { name: live.schedule, exact: true })).toBeVisible();
				expect(await layoutDefects(panel), `${locale} ${width} ${stop}`).toEqual([]);
				await expect(page.locator('html')).toHaveJSProperty('scrollWidth', width);
			}
			// A first report that cannot be read offers a retry, not an empty list.
			reportedAt = null;
			await page.goto(localizeHref('/stop/T6-HUB?tab=detail', locale, 'stm'));
			const panel = panelOf(page);
			await expect(
				panel.locator('[data-toc="stop-detail-departures"]').getByRole('button', {
					name: /retry|réessayer/i,
				}),
			).toBeVisible();
			await expect(panel.getByTestId('stop-live-state')).toHaveCount(0);
		}
	});
}
