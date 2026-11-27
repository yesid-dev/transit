import { readFileSync } from 'node:fs';
import { expect, type Locator, type Page } from '@playwright/test';
import { test } from './layout-test';
import { expectLayout } from './layout-debt';
import { forwardRoute } from './layout-helpers';
import { navPillCopy } from '../src/lib/i18n/messages';
import { headerSearchCopy } from '../src/lib/components/shell/headerSearch.copy';
import { localizeHref } from '../src/lib/i18n/routing';

const stop = JSON.parse(readFileSync(new URL('./stops-index.json', import.meta.url), 'utf8'))
	.stops[0];
const address = { lat: stop.lat, lon: stop.lon, label: 'Fixture address', source: 'geo_ca' };
const epoch = Date.parse(
	JSON.parse(readFileSync(new URL('./departures.json', import.meta.url), 'utf8')).generated_utc,
);

// Where each row sits in the list's scrolling content: scrolling the list does not change it.
const boxes = (list: Locator) =>
	list.locator('.search-list-scroll [role="option"]').evaluateAll((options) =>
		options.map((option) => {
			const scroller = option.closest('.search-list-scroll')!;
			const s = scroller.getBoundingClientRect();
			const r = option.getBoundingClientRect();
			return {
				id: option.id,
				top: r.top - s.top + scroller.scrollTop,
				left: r.left,
				right: r.right,
			};
		}),
	);

// Every row on screen stays inside the viewport (rows scrolled out of the list count by the part
// still showing); the pinned row, or with no match the message, is in view.
async function expectInView(page: Page, list: Locator) {
	const { width, height } = page.viewportSize()!;
	const outside = await list.locator('[role="option"]').evaluateAll(
		(options, viewport) =>
			options.flatMap((option) => {
				const r = option.getBoundingClientRect();
				const bottom = option.closest('.search-list-scroll')?.getBoundingClientRect().bottom;
				if (bottom !== undefined && r.top >= bottom) return [];
				const shown = Math.min(r.bottom, bottom ?? r.bottom);
				return r.left < 0 || r.right > viewport.width || shown > viewport.height ? [option.id] : [];
			}),
		{ width, height },
	);
	expect(outside, 'options outside the viewport').toEqual([]);
	const pinned = list.locator('[id$="-all"]');
	await expect(
		(await pinned.count()) ? pinned : page.locator('.search-list-none:visible'),
	).toBeInViewport();
}

for (const locale of ['en', 'fr'] as const)
	for (const query of [stop.name, 'zzzz'])
		test(`${locale} header search list "${query}" stays in view, rows stay put @layout`, async ({
			page,
		}, info) => {
			// The list drops from the header's field from 1280 px; narrower headers open the sheet.
			const inSheet = page.viewportSize()!.width < 1280;
			let release!: () => void;
			const addressesArrive = new Promise<void>((resolve) => (release = resolve));
			await page.clock.setFixedTime(epoch + 30_000);
			await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
			// Like every layout spec with data: WebKit refuses the data origin unless Playwright serves it.
			await page.route('**/v1/**', (route) =>
				forwardRoute(page, async () => {
					const url = new URL(route.request().url());
					url.pathname = `/__layout/fresh${url.pathname.replace('/octranspo/', '/stm/')}`;
					await route.fulfill({ response: await route.fetch({ url: url.href }) });
				}),
			);
			await page.route('**/api/geocode**', async (route) => {
				await addressesArrive;
				await route.fulfill({ json: { results: [{ ...address, precision: 'address' }] } });
			});
			try {
				await page.goto(localizeHref('/', locale), { waitUntil: 'networkidle' });
				// Typing before hydration is reset; the geocoder answer is held until released.
				await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
				const name = navPillCopy[locale].searchAria.all;
				const list = page.getByRole('listbox', { name });
				if (inSheet) {
					await page.getByRole('button', { name, exact: true }).click();
					await expect(
						page.getByRole('dialog', { name: headerSearchCopy[locale].sheetTitle }),
					).toBeVisible();
				}
				await expect(async () => {
					await page.getByRole('combobox', { name }).fill(query);
					await expect(list.getByRole('option').first()).toBeVisible({ timeout: 1_000 });
				}).toPass();
				await page.evaluate(() => document.fonts.ready);
				await expectInView(page, list);
				// The address row is replaced by the addresses; the pinned row may move down with the list.
				const before = (await boxes(list)).filter((box) => !/-(all|address)$/.test(box.id));
				const words = headerSearchCopy[locale];
				await list.getByRole('option', { name: words.askAddresses(query) }).click();
				release();
				await expect(
					list.getByRole('option', { name: `${words.kind.address} ${address.label}` }),
				).toBeVisible();
				const after = new Map((await boxes(list)).map((box) => [box.id, box]));
				expect(before.map((box) => after.get(box.id))).toEqual(before);
				await expectInView(page, list);
				await expectLayout(page, info, []);
			} finally {
				// A held geocoder answer would otherwise hang the page teardown after an early failure.
				release();
			}
		});

// The Search page is one centred column (owner, 27 November): its title, field and results card
// keep equal margins at every desktop width, with results, with none, before typing and with a
// name long enough to wrap. Phones keep every row on screen. One project per theme runs the matrix.
const longName = 'Station Université-de-Montréal (Édouard-Montpetit / Louis-Colin, côté nord-est)';
const searchIndex = {
	schedule: {
		date: '2026-11-21',
		routes: [{ id: '51', short: '51', long: 'Édouard-Montpetit', type: 3 }],
		stops: Array.from({ length: 12 }, (_, i) => ({
			id: `p${i}`,
			code: String(51000 + i),
			lat: 45.5,
			lon: -73.6,
			name: i % 2 ? longName : 'Côte-Sainte-Catherine / Légaré',
			routes: ['51'],
		})),
	},
	vehicles: [{ id: '40061' }],
	vehicle_state: 'ready',
};

for (const locale of ['en', 'fr'] as const)
	test(`${locale} search page column is centred and fits every width @layout`, async ({
		page,
	}, info) => {
		test.skip(!/^layout-chromium-1440-/.test(info.project.name), 'one Chromium project per theme');
		await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
		await page.route('**/api/search-index**', (route) => route.fulfill({ json: searchIndex }));
		const column = page.locator('[data-slot="search-column"]');
		// Typing the first letter, or finding nothing, never moves the footer.
		const footers = new Map<string, number>();
		const parts = [
			'h1',
			'.search-lede',
			'[data-slot="listing-search-field"]',
			'[data-search-card]',
		];
		for (const query of ['', '51', 'zzzz', 'Université']) {
			const q = query ? `&q=${encodeURIComponent(query)}` : '';
			await page.goto(localizeHref(`/search?provider=stm${q}`, locale));
			await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
			if (query === '51' || query === 'Université')
				await expect(page.locator('[data-search-card] section').first()).toBeVisible();
			else if (query)
				await expect(page.locator('[data-search-card] [role="status"]').first()).toHaveText(/zzzz/);
			await page.evaluate(() => document.fonts.ready);
			// The column is pure CSS: resizing the same page measures every width.
			for (const [width, height] of [
				[1920, 1080],
				[1440, 900],
				[1280, 900],
				[1024, 768],
				[390, 844],
				[320, 640],
			] as const) {
				await page.setViewportSize({ width, height });
				await page.evaluate(
					() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
				);
				const at = `${query || 'empty'} at ${width}`;
				const box = await column.evaluate((el) => {
					const r = el.getBoundingClientRect();
					const doc = document.documentElement;
					return {
						left: r.left,
						right: doc.clientWidth - r.right,
						scroll: doc.scrollWidth - doc.clientWidth,
					};
				});
				expect(box.scroll, `${at}: no sideways scroll`).toBe(0);
				if (width >= 1024)
					expect(
						Math.abs(box.left - box.right),
						`${at}: margins ${box.left} and ${box.right}`,
					).toBeLessThanOrEqual(1);
				// Every part of the screen shares the column's left edge and stays inside it.
				const edges = await page.evaluate(
					({ selectors, root }) => {
						const c = document.querySelector(root)!.getBoundingClientRect();
						return selectors.map((selector) => {
							const r = document.querySelector(`${root} ${selector}`)?.getBoundingClientRect();
							return r && { selector, left: r.left - c.left, over: r.right - c.right };
						});
					},
					{ selectors: parts, root: '[data-slot="search-column"]' },
				);
				for (const edge of edges.filter(Boolean)) {
					expect(edge!.over, `${at}: ${edge!.selector} inside the column`).toBeLessThanOrEqual(0.5);
					expect(
						Math.abs(edge!.left),
						`${at}: ${edge!.selector} on the column edge`,
					).toBeLessThanOrEqual(1);
				}
				if (query === '' || query === 'zzzz')
					footers.set(
						`${query}@${width}`,
						await page.evaluate(() =>
							Math.round(
								document.querySelector('footer')!.getBoundingClientRect().top + window.scrollY,
							),
						),
					);
				const rows = page.locator('[data-search-card] li a');
				for (const row of await rows.all()) {
					const r = (await row.boundingBox())!;
					expect(r.x + r.width, `${at}: row inside the screen`).toBeLessThanOrEqual(width);
				}
			}
		}
		// At 320 by 640 the no-result card alone is taller than the first screen.
		for (const width of [1920, 1440, 1280, 1024, 390])
			expect(footers.get(`zzzz@${width}`), `footer at ${width}`).toBe(footers.get(`@${width}`));
		await page.setViewportSize(info.project.use.viewport!);
		await expectLayout(page, info, []);
	});
