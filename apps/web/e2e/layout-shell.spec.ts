import { expect, type Locator, type Page } from '@playwright/test';
import { test } from './layout-test';
import { waitForFrameClearance } from './layout-helpers';
import { navPillCopy } from '../src/lib/i18n/messages';
import { headerSearchCopy } from '../src/lib/components/shell/headerSearch.copy';
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
		}
		await info.attach('navbar-navigation', {
			body: JSON.stringify(navigation),
			contentType: 'application/json',
		});
	});
}

// Owner ruling (16 November 2026): grouped menus read as organized columns from 768px and as one
// column below it. Layout offsets, not client rects, so the menu's opening transform cannot skew them.
async function menuRows(page: Page) {
	return page.evaluate(() => {
		const headings = [
			...document.querySelectorAll<HTMLElement>('[role="dialog"] .menu-group-heading'),
		];
		const rows = new Map<number, number>();
		for (const heading of headings) {
			const top = Math.round(heading.offsetTop);
			rows.set(top, (rows.get(top) ?? 0) + 1);
		}
		return [...rows.values()];
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
		const neighbour = (element: Element, step: 'previous' | 'next') => {
			for (
				let node = element[step === 'previous' ? 'previousElementSibling' : 'nextElementSibling'];
				node;
				node = node[step === 'previous' ? 'previousElementSibling' : 'nextElementSibling']
			)
				if (shown(node)) return node;
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
			await expect(language).toHaveAccessibleName(new RegExp(copy.names[locale]));
			const refresh = pill.getByRole('button', { name: copy.refresh, exact: true });
			await expect(refresh).toHaveCount(0);
			if (width < 1024) {
				const search = pill.getByRole('button', { name: copy.searchAria.all, exact: true });
				await targetFits(search, page);
				await expect(search).toHaveText(headerSearchCopy[locale].trigger);
				await singleLine(search.locator('span'));
			}
			await menu.focus();
			await page.keyboard.press('Enter');
			await expect(page.getByRole('dialog', { name: copy.menu })).toBeVisible();
			// One column below 768px; organized columns from 768px, four across at desktop width.
			const rows = await menuRows(page);
			expect(rows, `${width}px menu rows`).toEqual(
				width < 768 ? [1, 1, 1, 1] : width === 768 ? [2, 2] : [4],
			);
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
