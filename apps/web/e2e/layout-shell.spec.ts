import { expect, type Locator, type Page } from '@playwright/test';
import { test } from './layout-test';
import { waitForFrameClearance } from './layout-helpers';
import { navPillCopy } from '../src/lib/i18n/messages';
import { localizeHref } from '../src/lib/i18n/routing';

async function targetFits(control: Locator, page: Page) {
	await expect(control).toBeVisible();
	const box = (await control.boundingBox())!;
	expect(box.width).toBeGreaterThanOrEqual(44);
	expect(box.height).toBeGreaterThanOrEqual(44);
	expect(box.x).toBeGreaterThanOrEqual(0);
	expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
}

async function pillFits(pill: Locator) {
	const box = (await pill.boundingBox())!;
	expect(box.x).toBeGreaterThanOrEqual(0);
	expect(box.x + box.width).toBeLessThanOrEqual(
		await pill.evaluate(() => document.documentElement.clientWidth),
	);
}

async function singleLine(label: Locator) {
	expect(
		await label.evaluate((element) => {
			const range = document.createRange();
			range.selectNodeContents(element);
			return range.getClientRects().length;
		}),
	).toBe(1);
}

for (const [surface, path] of [
	['default', '/'],
	// November 17 is held by the Daily report streaming fixture. Pin this
	// navbar check to the normal Record period so it never picks up that hold.
	['Record', '/receipt?recordFrom=2026-11-18&recordTo=2026-11-20'],
]) {
	test(`French navbar stays on one row on phones on the ${surface} page`, async ({
		page,
	}, info) => {
		await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
		const navigation: { width: number; loadMs: number }[] = [];
		for (const width of [320, 360, 375, 390, 414]) {
			await page.setViewportSize({ width, height: 844 });
			const start = performance.now();
			const response = await page.goto(localizeHref(path, 'fr', 'stm'));
			navigation.push({ width, loadMs: Math.round(performance.now() - start) });
			expect(response?.status()).toBe(200);
			await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
			await waitForFrameClearance(page);

			const pill = page.getByTestId('nav-pill');
			await pillFits(pill);
			const controls = [
				pill.locator('[data-slot="product-brand"]'),
				pill.getByRole('button', { name: /Rechercher/ }),
				pill.getByTestId('theme-toggle'),
				pill.getByTestId('language-toggle'),
				pill.getByTestId('nav-menu-toggle'),
			];
			const centers = [];
			for (const control of controls) {
				await targetFits(control, page);
				const box = (await control.boundingBox())!;
				centers.push(box.y + box.height / 2);
			}
			expect(
				Math.max(...centers) - Math.min(...centers),
				`${path} at ${width}px`,
			).toBeLessThanOrEqual(1);
			// "yesid. | Transit |": no brand word touches a divider, at the 320px floor too.
			const gaps = await pill.evaluate((element) => {
				const parts = [
					'[data-slot="wordmark"]',
					'.product-brand-divider',
					'[data-slot="product-brand-name"]',
				].map((selector) => element.querySelector(selector)!.getBoundingClientRect());
				const next = [...element.querySelectorAll('.nav-divider')]
					.map((divider) => divider.getBoundingClientRect())
					.find((box) => box.width > 0 && box.left >= parts[2]!.right);
				return [
					parts[1]!.left - parts[0]!.right,
					parts[2]!.left - parts[1]!.right,
					...(next ? [next.left - parts[2]!.right] : []),
				];
			});
			for (const gap of gaps)
				expect(gap, `${path} brand gaps at ${width}px`).toBeGreaterThanOrEqual(3.5);
		}
		await info.attach('navbar-navigation', {
			body: JSON.stringify(navigation),
			contentType: 'application/json',
		});
	});
}

// Owner ruling (16 November 2026): grouped menus read as organized columns from 768px and as one
// column below it. Layout offsets, not client rects, so the menu's opening transform cannot skew them.
async function menuLayout(page: Page) {
	return page.evaluate(() => {
		const rows = new Map<number, DOMRect[]>();
		for (const group of document.querySelectorAll('[role="dialog"] [data-slot="menu-group"]')) {
			const box = group.getBoundingClientRect();
			const top = Math.round(box.top);
			rows.set(top, [...(rows.get(top) ?? []), box]);
		}
		const viewport = document.documentElement.clientWidth;
		const lines = [...document.querySelectorAll('[role="dialog"] .menu-label')].map((label) => {
			const range = document.createRange();
			range.selectNodeContents(label);
			return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
		});
		const row = [...rows.values()];
		return {
			counts: row.map((boxes) => boxes.length),
			outer: row.map((boxes) => [boxes[0]!.left, viewport - boxes.at(-1)!.right]),
			gaps: row.flatMap((boxes) =>
				boxes.slice(1).map((box, index) => box.left - boxes[index]!.right),
			),
			lines,
		};
	});
}

// The owner also asked for equal symmetric space on both sides of every navbar `|`. Measure the real
// gap from each visible divider to its nearest visible neighbour, including ProductBrand's divider.
async function pillDividerGaps(page: Page) {
	return page.evaluate(() => {
		const shown = (element: Element | null): element is HTMLElement => {
			if (!(element instanceof HTMLElement)) return false;
			if (getComputedStyle(element).visibility === 'hidden') return false;
			// An out-of-flow control (Transit drops the provider row below the pill on phones)
			// does not set the flow space beside a divider.
			if (['absolute', 'fixed'].includes(getComputedStyle(element).position)) return false;
			return element.getBoundingClientRect().width > 0.5;
		};
		type Direction = 'previous' | 'next';
		const boundary = (element: Element, step: Direction): HTMLElement | null => {
			if (shown(element)) return element;
			if (getComputedStyle(element).display !== 'contents') return null;
			const children = Array.from(element.children);
			if (step === 'previous') children.reverse();
			for (const child of children) {
				const candidate = boundary(child, step);
				if (candidate) return candidate;
			}
			return null;
		};
		const neighbour = (element: Element, step: Direction) => {
			const sibling = step === 'next' ? 'nextElementSibling' : 'previousElementSibling';
			for (let node = element[sibling]; node; node = node[sibling]) {
				const candidate = boundary(node, step);
				if (candidate) return candidate;
			}
			return null;
		};

		const pill = document.querySelector('[data-testid="nav-pill"]')!;
		return [...pill.querySelectorAll('.nav-divider, .product-brand-divider')]
			.filter(shown)
			.map((divider) => {
				const box = divider.getBoundingClientRect();
				const parent = divider.parentElement!;
				const before = neighbour(divider, 'previous') ?? neighbour(parent, 'previous');
				const after = neighbour(divider, 'next') ?? neighbour(parent, 'next');
				return {
					label: divider.className,
					left: before ? box.left - before.getBoundingClientRect().right : null,
					right: after ? after.getBoundingClientRect().left - box.right : null,
				};
			});
	});
}

for (const locale of ['en', 'fr'] as const)
	test(`${locale} shell keeps its labelled search and both toggles at every header width`, async ({
		page,
	}) => {
		await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
		const copy = navPillCopy[locale];
		for (const width of [320, 360, 390, 767, 768, 1206, 1280]) {
			await page.setViewportSize({ width, height: 900 });
			await page.goto(localizeHref('/privacy?provider=stm', locale));
			await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
			const pill = page.getByTestId('nav-pill');
			await pillFits(pill);
			await singleLine(pill.locator('[data-slot="product-brand-name"]'));

			if (width >= 1024) {
				// The kit places the city visually before moving its DOM node into desktop Tab order.
				await expect
					.poll(() =>
						pill
							.locator('[data-slot="site-header-network"]')
							.evaluate(
								(city) =>
									getComputedStyle(city).position === 'absolute' ||
									city.nextElementSibling?.classList.contains('nav-trailing') === true,
							),
					)
					.toBe(true);
			}

			// Every `|` keeps the same space on both sides, whatever tier supplies it. Below 360px the
			// kit draws no navbar divider at all, so 320px has nothing to measure.
			const gaps = await pillDividerGaps(page);
			if (width >= 360) expect(gaps.length, `visible dividers at ${width}px`).toBeGreaterThan(0);
			for (const gap of gaps) {
				expect(gap.left, `${width}px ${gap.label} left gap`).not.toBeNull();
				expect(gap.right, `${width}px ${gap.label} right gap`).not.toBeNull();
				expect(
					Math.abs(gap.left! - gap.right!),
					`${width}px ${gap.label} gaps`,
				).toBeLessThanOrEqual(1);
				expect(Math.min(gap.left!, gap.right!)).toBeGreaterThan(0);
			}
			const theme = pill.getByRole('switch', { name: copy.theme });
			const language = pill.getByTestId('language-toggle');
			const menu = pill.getByRole('button', { name: copy.openMenu, exact: true });
			for (const control of [theme, language, menu]) await targetFits(control, page);
			// The toggle is named by the language it leads to (yesid.design 0.58.1).
			await expect(language).toHaveAccessibleName(
				new RegExp(copy.names[locale === 'en' ? 'fr' : 'en']),
			);
			const refresh = pill.getByRole('button', { name: copy.refresh, exact: true });
			await expect(refresh).toHaveCount(0);
			if (width < 1024) {
				const search = pill.getByRole('button', { name: copy.searchAria.all, exact: true });
				await targetFits(search, page);
				// An icon button, as on yesid.dev: the brand keeps "yesid. | Transit" beside it.
				await expect(search).toHaveText('');
				await expect(
					pill.locator('[data-slot="product-brand"] a[data-slot="wordmark"]'),
				).toBeVisible();
			} else if (width < 1280) {
				// Beside the page links the search is the icon button that opens the sheet.
				const search = pill.getByRole('button', { name: copy.searchAria.all, exact: true });
				await targetFits(search, page);
				await expect(search).toHaveText('');
				await expect(pill.getByRole('combobox', { name: copy.searchAria.all })).toHaveCount(0);
			}
			await menu.focus();
			await page.keyboard.press('Enter');
			await expect(page.getByRole('dialog', { name: copy.menu })).toBeVisible();
			// One column below 768px. From 768px the kit centres the groups as content-sized columns with
			// one gap and keeps every destination label on one line while its row has room, so a group
			// moves to the next row instead: French needs 1280px for all four in one row.
			const wrappedRows: Record<number, number[]> =
				locale === 'fr' ? { 768: [2, 1, 1], 1206: [3, 1] } : { 768: [2, 2] };
			const layout = await menuLayout(page);
			expect(layout.counts, `${width}px menu rows`).toEqual(
				width < 768 ? [1, 1, 1, 1] : (wrappedRows[width] ?? [4]),
			);
			if (width >= 768) {
				expect(layout.lines, `${width}px menu labels on one line`).toEqual(
					layout.lines.map(() => 1),
				);
				for (const [left, right] of layout.outer)
					expect(Math.abs(left! - right!), `${width}px menu row centred`).toBeLessThanOrEqual(1);
				for (const gap of layout.gaps)
					expect(Math.abs(gap - layout.gaps[0]!), `${width}px menu gaps`).toBeLessThanOrEqual(1);
			}
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
				width,
			);
			await pillFits(pill);
			await singleLine(pill.locator('[data-slot="product-brand-name"]'));
			await expect(refresh).toHaveCount(0);
			await expect(
				pill.getByRole('button', { name: copy.searchAria.all, exact: true }),
			).toBeHidden();
			for (const control of [theme, language]) await targetFits(control, page);
			await expect(page.getByTestId('theme-toggle')).toHaveCount(1);
			await expect(page.getByTestId('language-toggle')).toHaveCount(1);
			await page.keyboard.press('Escape');
			await expect(menu).toBeFocused();
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
				width,
			);
			await expect(page.getByTestId('footer').getByText(/^(SYSTEM|SYSTÈME)/)).toHaveCount(0);
		}
	});
