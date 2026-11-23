import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

import { detailCopy } from '../src/lib/features/lines/lines.copy';
import { PUBLISHED_LOCALES } from '../src/lib/i18n/config';
import { localizeHref } from '../src/lib/i18n/routing';
import { waitForFrameClearance } from './layout-helpers';

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const b9 = read('../scripts/__fixtures__/b9/rich.json');
const manifest = read('./manifest.json');
const provider = manifest.provider;

test.use({ bypassCSP: true });

test.beforeEach(async ({ page }) => {
	await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
	await page.clock.setFixedTime(Date.parse(b9.frozen_utc) + 30_000);
});

for (const locale of PUBLISHED_LOCALES) {
	test(
		locale + ': Line Record links keep the date range when switching to Schedule or Live',
		async ({ page }) => {
			await page.goto(
				localizeHref('/lines/24?recordFrom=2026-11-08&recordTo=2026-11-14', locale, provider),
			);
			const views = page.getByRole('navigation', { name: /Line views|Vues de la ligne/ });
			await expect(views.getByRole('link', { name: /Record|Bilan/ })).toHaveAttribute(
				'aria-current',
				'page',
			);
			await views.getByRole('link', { name: /Schedule|Horaire/ }).click();
			await expect(views.getByRole('link', { name: /Schedule|Horaire/ })).toHaveAttribute(
				'aria-current',
				'page',
			);
			await expect(page).toHaveURL(
				(url) =>
					url.searchParams.get('tab') === 'schedule' &&
					url.searchParams.get('recordFrom') === '2026-11-08',
			);
			await views.getByRole('link', { name: /Live now|En direct/ }).click();
			await expect(views.getByRole('link', { name: /Live now|En direct/ })).toHaveAttribute(
				'aria-current',
				'page',
			);
			await expect(page).toHaveURL(
				(url) =>
					url.searchParams.get('frameMode') === 'live' &&
					url.searchParams.get('recordTo') === '2026-11-14',
			);
		},
	);
}

for (const locale of PUBLISHED_LOCALES) {
	test(`${locale}: Live keeps real-size destinations usable at 320 to 1280`, async ({
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
			const defects = await panel.evaluate((element) => {
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
			await expect(page.locator('html')).toHaveJSProperty('scrollWidth', width);
			await page.goto(localizeHref('/lines/9004?tab=detail', locale, provider));
			await expect(page.locator('[data-slot="line-no-live"]')).toBeVisible();

			await expect(
				page
					.getByRole('navigation', { name: /Line views|Vues de la ligne/ })
					.getByRole('link', { name: /Live now|En direct/ }),
			).toHaveAttribute('aria-current', 'page');
		}
	});
}
