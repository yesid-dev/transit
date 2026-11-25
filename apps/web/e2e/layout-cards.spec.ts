import { test } from './layout-test';
import { expect, type Page } from '@playwright/test';
import { localizeHref } from '../src/lib/i18n/routing';
import { openNetworkCapture } from './capture-fixture';
import { settled } from './design-pass-measure';
import type { SearchIndex } from '../src/lib/search/searchIndex';

const searchLineName = 'Sherbrooke / Boulevard des Anciens-Combattants';

async function serveSearchCards(page: Page) {
	await page.route('**/api/search-index?*', async (route) => {
		const response = await route.fetch();
		expect(response.ok()).toBe(true);
		const index: SearchIndex = await response.json();
		const schedule = index.schedule!;
		const line = schedule.routes.find(({ id }) => id === '24')!;
		schedule.routes = ['24', '241', '242', '243', '244', '245', '246'].map((id) => ({
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
		test(
			provider + ' ' + locale + ' search keeps names whole within its result rows',
			async ({ page }) => {
				await page.clock.setFixedTime(Date.parse('2026-06-15T12:00:30Z'));
				await serveSearchCards(page);
				await page.goto(localizeHref('/search?q=24&kind=route', locale, provider), {
					waitUntil: 'networkidle',
				});
				const list = page.getByRole('main').getByRole('list').first();
				const rows = list.getByRole('listitem');
				await expect(rows).toHaveCount(6);
				const firstLink = rows.first().getByRole('link');
				await expect(firstLink).toContainText(searchLineName);
				await expect(firstLink).toHaveAttribute(
					'href',
					localizeHref('/lines/24', locale, provider),
				);
				for (const width of [320, 390, 768, 1024, 1440]) {
					await page.setViewportSize({ width, height: 900 });
					await settled(page);
					// The responsive frame can move the whole Search surface after a resize.
					const { tabBottom, rowTop } = await firstLink.evaluate((link) => ({
						tabBottom: Math.max(
							...Array.from(
								link.closest('main')!.querySelectorAll('[role="tab"]'),
								(tab) => tab.getBoundingClientRect().bottom,
							),
						),
						rowTop: link.getBoundingClientRect().top,
					}));
					expect(tabBottom, `Tabs clear search rows at ${width}px`).toBeLessThanOrEqual(rowTop);
					expect(
						await rows.evaluateAll((items) =>
							items.flatMap((item) => {
								const link = item.querySelector('a')!;
								const label = link.querySelector('.search-list-label')!;
								const row = item.getBoundingClientRect();
								const bounds = link.getBoundingClientRect();
								return label.scrollWidth > label.clientWidth + 1 ||
									bounds.left < row.left - 1 ||
									bounds.right > row.right + 1 ||
									bounds.height < 44
									? [link.textContent]
									: [];
							}),
						),
						`Search rows at ${width}px`,
					).toEqual([]);
				}
			},
		);

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

// Keep the reporting figure and following content steady as the known and unknown delay counts change.
const fleets = [
	[40, 30],
	[40, 29],
	[80, 40],
	[81, 40],
] as const;
const fleet = ([total, measured]: readonly [number, number]) =>
	Array.from({ length: total }, (_, index) => (index < measured ? 0 : null));

for (const locale of ['en', 'fr'] as const)
	test(`${locale} Network live reporting keeps its place as status counts change`, async ({
		page,
	}) => {
		const refresh = await openNetworkCapture(page, locale, fleet(fleets[0]));
		const answer = page.locator('[data-slot="screen-answer"] [data-slot="answer-lead"]');
		const statusTitle = locale === 'en' ? 'Vehicles by status' : 'Véhicules par état';
		const status = page.getByRole('article', { name: statusTitle });
		const unknown = status.locator('div:has(> dt [data-status="unknown"]) > dd');
		for (const width of [320, 390, 1440]) {
			await page.setViewportSize({ width, height: 900 });
			await page.evaluate(() => document.fonts.ready);
			const sizes = [];
			for (const sample of fleets) {
				await refresh(fleet(sample));
				await expect(unknown).toContainText(
					new RegExp(`^${sample[0] - sample[1]} (?:vehicle|véhicule)`),
				);
				sizes.push({
					height: (await answer.boundingBox())!.height,
					next: (await status.boundingBox())!.y,
				});
			}
			for (const [i, size] of sizes.entries()) {
				const at = `${width}px, ${fleets[i].join(' in service, ')} readings`;
				expect(Math.abs(size.height - sizes[0].height), `${at}: answer height`).toBeLessThan(0.5);
				expect(Math.abs(size.next - sizes[0].next), `${at}: status card position`).toBeLessThan(
					0.5,
				);
			}
		}
	});
