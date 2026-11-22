import { expect, type Page } from '@playwright/test';
import { test } from './layout-input-test';

for (const provider of ['stm', 'octranspo']) {
	for (const prefix of ['', '/fr']) {
		test(`${provider} ${prefix || 'en'} content scrolls the window and map stays in the viewport`, async ({
			page,
		}) => {
			await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
			await page.goto(`${prefix}/privacy?provider=${provider}`);
			await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
			await expect(page.locator('#page-scroller')).toHaveCount(0);
			await expect
				.poll(() => page.evaluate(() => document.scrollingElement!.scrollHeight - innerHeight))
				.toBeGreaterThan(0);
			await page.evaluate(() => window.scrollTo(0, 250));
			await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
			const chrome = page.locator('[data-slot="app-shell-chrome"]');
			expect((await chrome.boundingBox())!.y).toBe(0);
			await page.evaluate(() => window.scrollTo(0, 0));
			await page.locator('a[href="#main"]').focus();
			await expect(page.locator('a[href="#main"]')).toBeFocused();
			await page.keyboard.press('Enter');
			await expect(page.getByRole('main')).toBeFocused();
			// Exercise an actual in-page anchor with the fixed chrome offset.
			const anchor = page.locator('main [id]').last();
			const id = await anchor.getAttribute('id');
			expect(id).toBeTruthy();
			await page.evaluate((id) => {
				const link = document.createElement('a');
				link.href = `#${id}`;
				document.body.append(link);
				link.click();
				link.remove();
			}, id!);
			await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
			await expect(anchor).toBeInViewport();
			await page.goto(`${prefix}/map?provider=${provider}`);
			await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
			await expect(page.locator('[data-slot="app-shell"]')).toHaveAttribute(
				'data-full-viewport',
				'true',
			);
			await page.evaluate(() => window.scrollTo(0, 250));
			expect(await page.evaluate(() => scrollY)).toBe(0);
			expect(
				await page.evaluate(() => document.scrollingElement!.scrollHeight - innerHeight),
			).toBeLessThanOrEqual(1);
		});
	}
}

// The shell reserves one chrome clearance in flow. A legal page adds only its own
// reading gap on top of it, so the first line sits one clearance below the chrome. A second
// --chrome-offset would show up here as a gap as tall as that clearance.
const READING_GAP_REM = 4;
const BOTTOM_SPACE_REM = 6;

type LegalMetrics = {
	root: number;
	mainContentTop: number;
	chromeBottom: number;
	firstTop: number;
	lastContentBottom: number;
	articleBottom: number;
	contentSpill: number;
};

function legalMetrics(page: Page): Promise<LegalMetrics> {
	return page.evaluate(() => {
		const px = (value: string) => Number.parseFloat(value) || 0;
		const docTop = (element: Element) => element.getBoundingClientRect().top + scrollY;
		const docBottom = (element: Element) => element.getBoundingClientRect().bottom + scrollY;
		const main = document.querySelector<HTMLElement>('main')!;
		const article = document.querySelector<HTMLElement>('[data-testid="legal-document"]')!;
		// The app frame controls and the pill form the sticky chrome.
		const pill = document.querySelector<HTMLElement>('[data-testid="nav-pill"]')!;
		const controls = document.querySelector('[data-slot="app-frame-controls"]')!;
		const chrome = [pill, controls].filter((element) => element.checkVisibility());
		let contentSpill = article.getBoundingClientRect().right - innerWidth;
		for (const descendant of article.querySelectorAll('*')) {
			const rect = descendant.getBoundingClientRect();
			if (rect.width > 0)
				contentSpill = Math.max(contentSpill, rect.right - innerWidth, -rect.left);
		}
		return {
			root: px(getComputedStyle(document.documentElement).fontSize),
			mainContentTop: docTop(main) + px(getComputedStyle(main).paddingTop),
			chromeBottom: Math.max(...chrome.map(docBottom)),
			firstTop: docTop(article.firstElementChild!.firstElementChild!),
			lastContentBottom: docBottom(article.lastElementChild!.lastElementChild!),
			articleBottom: docBottom(article),
			contentSpill,
		};
	});
}

function expectOneHeaderClearance(metrics: LegalMetrics): void {
	const gap = metrics.firstTop - metrics.mainContentTop;
	// One shell clearance, then exactly the retained reading gap.
	expect(Math.abs(gap - READING_GAP_REM * metrics.root)).toBeLessThanOrEqual(1);
	// The gap starts below the fixed chrome, so the clearance is not dropped either.
	expect(metrics.firstTop - metrics.chromeBottom).toBeGreaterThanOrEqual(
		READING_GAP_REM * metrics.root,
	);
	expect(
		Math.abs(metrics.articleBottom - metrics.lastContentBottom - BOTTOM_SPACE_REM * metrics.root),
	).toBeLessThanOrEqual(1);
	expect(metrics.contentSpill).toBeLessThanOrEqual(1);
}

for (const kind of ['privacy', 'terms', 'accessibility'] as const) {
	for (const provider of ['stm', 'octranspo']) {
		for (const prefix of ['', '/fr']) {
			test(`${kind} ${provider} ${prefix ? 'fr' : 'en'} keeps one header clearance over its reading gap`, async ({
				page,
			}) => {
				await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
				await page.goto(`${prefix}/${kind}?provider=${provider}`);
				await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
				await expect(async () => expectOneHeaderClearance(await legalMetrics(page))).toPass();

				// An in-page jump stops clear of the fixed chrome, not under it.
				const ids = await page
					.locator('main [id]')
					.evaluateAll((nodes) => nodes.map((node) => node.id));
				const id = ids[Math.floor(ids.length / 2)];
				expect(id).toBeTruthy();
				await page.evaluate((anchor) => {
					const link = document.createElement('a');
					link.href = `#${anchor}`;
					document.body.append(link);
					link.click();
					link.remove();
				}, id!);
				await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
				const anchored = page.locator(`[id="${id}"]`);
				await expect(anchored).toBeInViewport();
				const chromeBottom = await page.getByTestId('nav-pill').evaluate((pill) => {
					const controls = document.querySelector('[data-slot="app-frame-controls"]')!;
					return Math.max(
						...[pill, controls]
							.filter((element) => element.checkVisibility())
							.map((element) => element.getBoundingClientRect().bottom),
					);
				});
				expect((await anchored.boundingBox())!.y).toBeGreaterThanOrEqual(chromeBottom - 1);

				// Text scaling keeps the same single clearance at the narrowest width.
				if (provider === 'stm' && !prefix) {
					await page.setViewportSize({ width: 320, height: 800 });
					await page.addStyleTag({ content: 'html { font-size: 200%; }' });
					await page.evaluate(() => window.scrollTo(0, 0));
					await expect.poll(async () => (await legalMetrics(page)).root).toBe(32);
					await expect(async () => expectOneHeaderClearance(await legalMetrics(page))).toPass();
				}
			});
		}
	}
}
