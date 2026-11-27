import { expect } from '@playwright/test';
import { test } from './layout-test';
import { expectLayout } from './layout-debt';
import { localizeHref } from '../src/lib/i18n/routing';

// The Search page is one centred column (owner, 27 November): its title, field and results card
// keep equal margins at every desktop width, with results, with none, before typing and with a
// name long enough to wrap. Phones keep every row on screen. The config runs this file in one Chromium
// project per theme (the matrix is its own), so every planned case runs.
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
