import { test } from './layout-test';
import { expect, type Page } from '@playwright/test';
import { localizeHref } from '../src/lib/i18n/routing';
import type { SearchIndex } from '../src/lib/search/searchIndex';

const searchLineName = 'Sherbrooke / Boulevard des Anciens-Combattants';

async function serveSearchCards(page: Page) {
	await page.route('**/api/search-index?*', async (route) => {
		const response = await route.fetch();
		expect(response.ok()).toBe(true);
		const index: SearchIndex = await response.json();
		const schedule = index.schedule!;
		const line = schedule.routes.find(({ id }) => id === '24')!;
		schedule.routes = ['24', '241', '242', '243', '244', '245'].map((id) => ({
			...line,
			id,
			short: id,
			long: searchLineName,
		}));
		await route.fulfill({ response, json: index });
	});
}

for (const provider of ['stm', 'octranspo'])
	for (const locale of ['en', 'fr'] as const)
		test(provider + ' ' + locale + ' search card container rules', async ({ page }) => {
			await page.clock.setFixedTime(Date.parse('2026-06-15T12:00:30Z'));
			await serveSearchCards(page);
			await page.goto(localizeHref('/search?q=24', locale, provider), { waitUntil: 'networkidle' });
			const list = page.locator('[data-slot="entity-list"]').first();
			await expect(list).toBeVisible();
			const row = list.locator('[data-slot="entity-result-row"]').first();
			const cards = list.locator('[data-slot="card"]');
			await expect(cards).toHaveCount(6);
			await expect(list.locator('[data-slot="entity-result-status"]')).toHaveCount(0);
			const firstLink = row.getByRole('link');
			await expect(firstLink).toContainText(searchLineName);
			await expect(firstLink).toHaveAttribute('href', localizeHref('/lines/24', locale, provider));
			// The same viewport exercises both sides of each container boundary.
			for (const [width, columns] of [
				[320, 1],
				[420, 1],
				[470, 1],
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
						cards.evaluateAll((items) => {
							const firstTop = items[0]!.getBoundingClientRect().top;
							return items.filter(
								(item) => Math.abs(item.getBoundingClientRect().top - firstTop) < 1,
							).length;
						}),
					)
					.toBe(columns);
				const clipped = await cards.evaluateAll((items) =>
					items.flatMap((item) => {
						const link = item.querySelector('a')!;
						const name = link.querySelector('.entity-row-subtitle')!;
						const card = item.getBoundingClientRect();
						const bounds = link.getBoundingClientRect();
						return name.scrollWidth > name.clientWidth + 1 ||
							bounds.left < card.left - 1 ||
							bounds.right > card.right + 1
							? [link.textContent]
							: [];
					}),
				);
				expect(clipped, `Card text at ${width}px`).toEqual([]);
			}
		});

for (const provider of ['stm', 'octranspo'])
	for (const locale of ['en', 'fr'] as const)
		test(
			provider + ' ' + locale + ' Line finder keeps identity and evidence together across widths',
			async ({ page }) => {
				await page.goto(
					localizeHref('/lines', locale, provider) + '&recordFrom=2026-11-08&recordTo=2026-11-14',
				);
				const row = page
					.getByRole('row')
					.filter({ has: page.getByRole('link', { name: /24 · Sherbrooke/ }) });
				for (const width of [320, 390, 470, 743, 1280]) {
					await page.setViewportSize({ width, height: 900 });
					await expect(row).toBeVisible();
					await expect(row).toContainText(/80\s?%/u);
					await expect(row).toContainText(locale === 'fr' ? 'Faible couverture' : 'Low coverage');
					const name = row.getByRole('link');
					await expect(name).toContainText('Sherbrooke');
					expect(
						await name.evaluate(
							(element) =>
								element.scrollWidth <= element.clientWidth + 1 &&
								getComputedStyle(element).wordBreak !== 'break-all',
						),
					).toBe(true);
					await expect(page.locator('html')).toHaveJSProperty('scrollWidth', width);
				}
			},
		);

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
