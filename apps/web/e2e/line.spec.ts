import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

import { stampCopy } from '../src/lib/v1/stamp.copy';
import { intl } from '../src/lib/i18n/copy';
import { detailCopy as stopCopy } from '../src/lib/features/stops/stops.copy';
import { detailCopy } from '../src/lib/features/lines/lines.copy';
import { reliabilityCopy } from '../src/lib/features/lines/reliability/reliability.copy';
import { PUBLISHED_LOCALES } from '../src/lib/i18n/config';
import { localizeHref } from '../src/lib/i18n/routing';
import { waitForFrameClearance } from './layout-helpers';

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const b9 = read('../scripts/__fixtures__/b9/rich.json');
const line = read('./routes-index.json').routes[0];
const manifest = read('./manifest.json');
const provider = manifest.provider;
const publication = b9.files[`historic/route_reliability/${line.id}.json`].generated_utc.slice(
	0,
	10,
);
const route = b9.files[`static/routes/${line.id}.json`];

test.use({ bypassCSP: true });

test.beforeEach(async ({ page }) => {
	await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
	await page.clock.setFixedTime(Date.parse(b9.frozen_utc) + 30_000);
});

for (const locale of PUBLISHED_LOCALES) {
	const t = detailCopy[locale];

	test(`${locale}: a line page opens on its record and keeps the open tab in the URL`, async ({
		page,
	}) => {
		await page.goto(localizeHref(`/lines/${line.id}`, locale, provider));
		await expect(page.getByRole('heading', { level: 1 })).toHaveText(
			`${line.short} · ${route.long}`,
		);

		await expect(page.getByRole('tab')).toHaveText(Object.values(t.tabs));
		await expect(page.getByRole('tab', { selected: true })).toHaveText(t.tabs.reliability);
		// The record last, so the header shows its stamp below.
		for (const [key, name] of Object.entries(t.tabs).reverse()) {
			const tab = page.getByRole('tab', { name, exact: true });
			// Server markup shows the tabs before hydration wires them; retry until one responds.
			await expect(async () => {
				if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
				await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: 1_000 });
			}).toPass();
			await expect(page).toHaveURL(
				(url) => url.searchParams.get('tab') === (key === 'reliability' ? null : key),
			);
		}
		const date = intl
			.dateTime(locale, {
				month: 'short',
				day: 'numeric',
				timeZone: 'UTC',
				...(!manifest.tz ? { year: 'numeric' as const } : {}),
			})
			.format(new Date(publication));
		const header = page.locator('[data-slot="article-header"]');
		await expect(header.locator('time')).toHaveText(stampCopy[locale].record(null, date, 'window'));
		await expect(header.locator('time')).toHaveAttribute('datetime', publication);
		for (const section of Object.values(reliabilityCopy[locale].sections)) {
			if (typeof section !== 'object') continue;
			await expect(page.getByRole('region', { name: section.label, exact: true })).toBeVisible();
		}
	});

	test(`${locale}: a stop on the line opens its page`, async ({ page }) => {
		const [first] = route.directions[0].stops;
		await page.goto(localizeHref(`/lines/${line.id}`, locale, provider));
		const live = page.getByRole('tab', { name: t.tabs.schedule, exact: true });
		await expect(async () => {
			if ((await live.getAttribute('aria-selected')) !== 'true') await live.click();
			await expect(live).toHaveAttribute('aria-selected', 'true', { timeout: 1_000 });
		}).toPass();
		// Directions start closed: their stops are out of reach until one opens, here by keyboard.
		const stopLink = page.getByRole('link', {
			name: `${t.viewStop} ${first.seq} ${first.name}`,
			exact: true,
		});
		await expect(stopLink).toHaveCount(0);
		await page.locator('[data-slot="line-directions"] summary').first().press('Enter');
		await stopLink.first().click();

		await expect(page).toHaveURL(
			(url) =>
				url.pathname === localizeHref(`/stop/${first.id}`, locale) &&
				url.searchParams.get('provider') === provider,
		);
		await expect(page.getByRole('heading', { level: 1 })).toContainText(first.name);
		const code = b9.files['static/stops/' + first.id + '.json'].code;
		await expect(
			page
				.locator('[data-slot="article-header"]')
				.getByText(stopCopy[locale].info.code, { exact: true })
				.locator('..'),
		).toContainText(code);
	});
}

for (const locale of PUBLISHED_LOCALES)
	test(`${locale}: a phone never overlaps the record's daily labels`, async ({ page }) => {
		for (const width of [320, 390]) {
			await page.setViewportSize({ width, height: 900 });
			await page.goto(localizeHref('/lines/9001', locale, provider), { waitUntil: 'networkidle' });
			const chart = page.locator('[data-slot="otp-trend"] .day-chart');
			await expect(chart.locator('.day-chart__cols > li')).toHaveCount(7);
			const labels = await chart.evaluate((figure) =>
				[...figure.querySelectorAll('.day-chart__v, .day-chart__x > span')]
					.map((element) => ({ element, box: element.getBoundingClientRect() }))
					.filter(
						({ element, box }) =>
							getComputedStyle(element).visibility !== 'hidden' && box.width > 0 && box.height > 0,
					)
					.map(({ element, box }) => ({
						text: element.textContent,
						left: box.left,
						right: box.right,
						top: box.top,
						bottom: box.bottom,
					})),
			);
			const overlaps = labels.flatMap((a, i) =>
				labels
					.slice(i + 1)
					.filter(
						(b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom,
					)
					.map((b) => `${width}px ${a.text} / ${b.text}`),
			);
			expect(overlaps).toEqual([]);
			// A value too wide for its column still reaches screen readers and the table.
			await expect(chart.locator('.day-chart__cols > li').first()).toContainText(
				locale === 'fr' ? '89,8 %' : '89.8%',
			);
		}
	});

// Line 9002 (seeded in the data server): a month of real-size cuts and 15 published stops whose
// longest names must wrap whole at every width, beside their figures, with 44 px targets.
const longestStop =
	'Queen-Mary / Frère-André (Oratoire Saint-Joseph du Mont-Royal), quai en direction est';
for (const locale of PUBLISHED_LOCALES)
	test(`${locale}: the line's evidence wraps long stop names and never overflows`, async ({
		page,
	}) => {
		const t = reliabilityCopy[locale].evidence;
		for (const width of [320, 360, 390, 768, 1280]) {
			await page.setViewportSize({ width, height: 900 });
			await page.goto(localizeHref('/lines/9002', locale, provider), { waitUntil: 'networkidle' });
			const stops = page.locator('[data-slot="stop-delays"]');
			await stops.scrollIntoViewIfNeeded();
			const toggle = stops.getByRole('button', { name: t.stops.showAll('15') });
			await toggle.click();
			await expect(stops.locator('[data-slot="stop-delay-row"]')).toHaveCount(15);
			await expect(stops.getByRole('link', { name: longestStop })).toHaveText(longestStop);
			await expect(page.locator('[data-slot="time-of-day"] tbody tr')).not.toHaveCount(0);
			await expect(page.locator('[data-slot="gaps-table"] tbody tr')).toHaveCount(5);
			const report = await page.evaluate(() => {
				const box = (element: Element) => element.getBoundingClientRect();
				const meets = (a: DOMRect, b: DOMRect) =>
					a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
				const rows = [...document.querySelectorAll('[data-slot="stop-delay-row"]')];
				const targets = [
					...rows.map((row) => row.querySelector('a')!),
					document.querySelector('[data-slot="stop-delays-toggle"]')!,
				];
				const table = document.querySelector('[data-slot="time-of-day"]')!;
				const section = table.closest('[data-section]')!;
				const tables = ['time-of-day', 'gaps-table'].map(
					(slot) => document.querySelector(`[data-slot="${slot}"]`)!,
				);
				// A word wider than its cell's content box breaks inside the word: never allowed.
				const probe = document.body.appendChild(document.createElement('span'));
				probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap';
				const brokenWords = tables.flatMap((each) =>
					[...each.querySelectorAll('th, td')].flatMap((cell) => {
						const style = getComputedStyle(cell);
						// Longhands: with tabular-nums the `font` shorthand serializes as an empty string.
						for (const property of [
							'fontFamily',
							'fontSize',
							'fontWeight',
							'fontStyle',
							'fontStretch',
							'fontVariantNumeric',
							'letterSpacing',
						] as const)
							probe.style[property] = style[property];
						const room =
							cell.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
						return (cell.textContent ?? '')
							.split(/\s+/u)
							.filter(Boolean)
							.filter((word) => {
								probe.textContent = word;
								return probe.getBoundingClientRect().width > room + 0.5;
							})
							.map((word) => `${word} (${Math.round(room)} px)`);
					}),
				);
				probe.remove();
				return {
					brokenWords,
					tablesOverflow: tables.map((each) =>
						Math.max(0, box(each).right - box(each.closest('[data-section]')!).right),
					),
					overflow: document.documentElement.scrollWidth - window.innerWidth,
					clipped: rows
						.map((row) => row.querySelector('a')!)
						.filter((link) => link.scrollWidth > link.clientWidth + 1)
						.map((link) => link.textContent),
					short: targets
						.filter((target) => box(target).height < 44)
						.map((target) => target.textContent?.trim()),
					overlaps: rows
						.filter((row) =>
							meets(box(row.querySelector('a')!), box(row.querySelector('.stop-row__meta')!)),
						)
						.map((row) => row.querySelector('a')!.textContent),
					tableOverflow: box(table).right - box(section).right,
				};
			});
			expect(report.overflow, `${width}px page`).toBeLessThanOrEqual(0);
			expect(report.clipped, `${width}px clipped names`).toEqual([]);
			expect(report.short, `${width}px targets under 44 px`).toEqual([]);
			expect(report.overlaps, `${width}px name over figures`).toEqual([]);
			expect(report.tableOverflow, `${width}px time-of-day table`).toBeLessThanOrEqual(0.5);
			expect(report.brokenWords, `${width}px words broken inside a table cell`).toEqual([]);
			expect(report.tablesOverflow, `${width}px tables past their section`).toEqual([0, 0]);
		}
	});

for (const locale of PUBLISHED_LOCALES) {
	test(`${locale}: Live and Schedule keep real-size destinations usable at 320 to 1280`, async ({
		page,
	}, testInfo) => {
		await page.route(/\/v1\/stm\/provenance\.json/, (route) =>
			route.fulfill({
				json: {
					generated_utc: b9.frozen_utc,
					gaps: ['metro_realtime'],
					sources: [{ feed: 'static_schedule', last_loaded_utc: '2026-08-29T04:00:00Z' }],
				},
			}),
		);
		let vehiclesReady: Promise<void> = Promise.resolve();
		let releaseVehicles: () => void = () => {};
		const generated_utc = b9.frozen_utc;
		const vehicles = Array.from({ length: 13 }, (_, i) => ({
			id: `t4-bus-${i}`,
			route: '9003',
			trip: `t4-trip-${i}`,
			lat: 45.5,
			lon: -73.6,
			updated_utc: generated_utc,
			status: ['early', 'on_time', 'late', 'severe', 'unknown'][i % 5],
			delay_min: i === 12 ? null : [-1, -1, 1, 5, 0][i % 5],
			next_stop: `t4-${i}`,
		}));
		await page.route(/\/v1\/stm\/live\/(vehicles|trips|alerts|network)\.json/, async (request) => {
			const path = new URL(request.request().url()).pathname;
			const kind = path.split('/').at(-1)!;
			const bodies: Record<string, unknown> = {
				'vehicles.json': { generated_utc, vehicles },
				'trips.json': {
					generated_utc,
					feed_captured_utc: generated_utc,
					trips: {
						't4-trip-0': {
							route: '9003',
							status: 'on_time',
							delay_min: 2,
							stops: Array.from({ length: 61 }, (_, i) => ({
								stop: `t4-${i}`,
								eta_utc: '2026-08-30T16:05:00Z',
								delay_min: i === 1 ? null : 2,
							})),
						},
					},
				},
				'alerts.json': { generated_utc, feed_captured_utc: generated_utc, alerts: [] },
				'network.json': { ...b9.files['live/network.json'], generated_utc },
			};
			if (kind === 'vehicles.json') await vehiclesReady;
			await request.fulfill({ json: bodies[kind] });
		});
		for (const width of [320, 390, 768, 1280]) {
			await page.setViewportSize({ width, height: 900 });
			vehiclesReady = new Promise<void>((resolve) => {
				releaseVehicles = resolve;
			});
			await page.goto(localizeHref('/lines/9003?tab=detail', locale, provider));
			const panel = page.getByRole('tabpanel', {
				name: detailCopy[locale].tabs.detail,
				exact: true,
			});
			const header = page.locator('[data-slot="article-header"]');
			await waitForFrameClearance(page);
			const before = await header.boundingBox();
			releaseVehicles();
			await expect(panel.locator('[data-testid="route-roster"] li')).toHaveCount(13);
			expect((await header.boundingBox())?.height).toBe(before?.height);
			if (width === 1280) {
				const rosterBox = await panel.locator('[data-toc="line-detail-live"]').boundingBox();
				const predictionsBox = await panel
					.locator('[data-toc="line-detail-directions"]')
					.boundingBox();
				expect(rosterBox!.x + rosterBox!.width).toBeLessThanOrEqual(predictionsBox!.x);
			}
			const destination = panel.getByRole('combobox', { name: 'Destination' });
			await expect(destination).toHaveValue('0');
			await expect(panel.getByRole('table').locator('tbody tr')).toHaveCount(6);
			if (width === 320 || width === 1280) {
				await destination.scrollIntoViewIfNeeded();
				await page.screenshot({ path: testInfo.outputPath(`live-${locale}-${width}.png`) });
			}

			await destination.selectOption('1');
			await expect(panel.getByRole('table')).toHaveAccessibleName(/Rockcliffe via station/);
			await panel.getByRole('button', { name: /61/ }).click();
			await expect(panel.getByRole('table').locator('tbody tr')).toHaveCount(61);
			await expect(
				panel.getByRole('link', {
					name: /See the record of what ran|Voir le bilan du service assuré/,
				}),
			).toHaveAttribute('href', new RegExp('provider=stm'));
			await page.getByRole('tab', { name: detailCopy[locale].tabs.schedule, exact: true }).click();
			const schedule = page.getByRole('tabpanel', {
				name: detailCopy[locale].tabs.schedule,
				exact: true,
			});
			await expect(schedule.getByRole('table')).toContainText(
				locale === 'en' ? 'Time window not supplied' : 'Plage horaire non fournie',
			);
			const summary = schedule.locator('[data-slot="line-directions"] summary').first();
			await summary.press('Enter');
			await expect(summary.locator('..').getByRole('link')).toHaveCount(6);
			await summary.locator('..').getByRole('button', { name: /61/ }).click();
			await expect(summary.locator('..').getByRole('link')).toHaveCount(61);
			for (const root of [panel, schedule]) {
				await page
					.getByRole('tab', {
						name:
							root === panel ? detailCopy[locale].tabs.detail : detailCopy[locale].tabs.schedule,
						exact: true,
					})
					.click();
				await expect(root).toBeVisible();
				const defects = await root.evaluate((element) => {
					const viewport = document.documentElement.clientWidth;
					const bad: string[] = [];
					for (const node of element.querySelectorAll(
						'a,select,summary,button,th,td,.route-roster-next',
					)) {
						const rect = node.getBoundingClientRect();
						if (!rect.width || !rect.height) continue;
						if (rect.left < -1 || rect.right > viewport + 1)
							bad.push(`overflow: ${node.textContent} child ${rect.left},${rect.right}`);
						if (node.matches('a,select,summary,button') && rect.height < 44)
							bad.push(`target: ${node.textContent}`);
						if (node.matches('td,th')) {
							const parent = node.closest('table')!.parentElement!.getBoundingClientRect();
							if (rect.right > parent.right + 1) bad.push(`table overflow: ${node.textContent}`);
							const text = [...node.childNodes]
								.filter((child) => child.nodeType === Node.TEXT_NODE)
								.map((child) => child.textContent)
								.join(' ');
							const range = document.createRange();
							for (const child of node.childNodes) {
								if (child.nodeType !== Node.TEXT_NODE) continue;
								for (const match of (child.textContent ?? '').matchAll(/\S+/g)) {
									range.setStart(child, match.index!);
									range.setEnd(child, match.index! + match[0].length);
									if (
										range.getBoundingClientRect().height >
										Number.parseFloat(getComputedStyle(node).lineHeight) * 1.5
									)
										bad.push(`broken word: ${text}`);
								}
							}
						}
						if (node.matches('.route-roster-next') && node.scrollHeight > node.clientHeight + 1)
							bad.push(`clipped name: ${node.textContent}`);
						const style = getComputedStyle(node);
						if (style.wordBreak === 'break-all') bad.push(`broken word: ${node.textContent}`);
					}
					return bad;
				});
				expect(defects, `${locale} ${width}`).toEqual([]);
			}
			await expect(page.locator('html')).toHaveJSProperty('scrollWidth', width);
			await page.goto(localizeHref('/lines/9004?tab=detail', locale, provider));
			await expect(page.locator('[data-slot="line-no-live"]')).toBeVisible();
			await expect(
				page.getByRole('tab', { name: detailCopy[locale].tabs.detail, exact: true }),
			).toHaveCount(0);
			await expect(page.locator('[data-slot="freshness-stamp"]')).toHaveCount(0);
			await expect(page.locator('[data-slot="line-directions"] select')).toHaveCount(0);
			await expect(page.getByRole('table')).toContainText(
				locale === 'en' ? 'Time window not supplied' : 'Plage horaire non fournie',
			);
		}
	});
}
