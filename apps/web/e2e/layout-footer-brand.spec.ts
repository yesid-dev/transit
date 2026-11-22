import { expect, type Locator, type Page } from '@playwright/test';
import { test } from './layout-test';
import { localizeHref } from '../src/lib/i18n/routing';
import { announcement } from '../src/lib/site/announcement';

// The footer's brand cell is narrower than the brand row at 200% text: at 320px the cell is
// 224px wide and the house mark plus the product name measure 256px before any gap. The cluster
// therefore has to answer to its own column, not the viewport: it stacks at narrow columns and
// keeps today's row, fonts and gaps at desktop width.

type Provider = 'stm' | 'octranspo';
type Locale = 'en' | 'fr';
type Route = '/' | '/privacy';

type BrandCase = {
	route: Route;
	provider: Provider;
	locale: Locale;
	width: number;
	scale: 100 | 200;
};

const cases: BrandCase[] = [];
for (const route of ['/privacy', '/'] as const)
	for (const provider of ['stm', 'octranspo'] as const)
		for (const locale of ['en', 'fr'] as const)
			for (const width of [320, 360] as const)
				for (const scale of [100, 200] as const)
					cases.push({ route, provider, locale, width, scale });
// The desktop row, once per provider and locale at the ordinary viewport and text size.
for (const provider of ['stm', 'octranspo'] as const)
	for (const locale of ['en', 'fr'] as const)
		cases.push({ route: '/', provider, locale, width: 1280, scale: 100 });

const brand = (page: Page) => page.getByTestId('footer-brand');
const cluster = (page: Page) => brand(page).locator('[data-slot="product-brand"]');
const house = (page: Page) => cluster(page).locator('a[data-slot="wordmark"]');
const product = (page: Page) => cluster(page).locator('a[data-slot="product-brand-name"]');

type Box = {
	left: number;
	right: number;
	top: number;
	bottom: number;
	width: number;
	height: number;
};

const metrics = (page: Page) =>
	page.evaluate(() => {
		const box = (element: Element): Box => {
			const { left, right, top, bottom, width, height } = element.getBoundingClientRect();
			return { left, right, top, bottom, width, height };
		};
		// The cell the footer gives the brand: the wrapper's own parent.
		const wrapper = document.querySelector<HTMLElement>('[data-testid="footer-brand"]')!;
		const row = wrapper.querySelector<HTMLElement>('[data-slot="product-brand"]')!;
		const divider = row.querySelector<HTMLElement>(':scope > [aria-hidden="true"]')!;
		const links = [...row.querySelectorAll('a')].map((element) => {
			const link = element as HTMLAnchorElement;
			const style = getComputedStyle(link);
			return {
				text: (link.textContent ?? '').trim(),
				href: link.getAttribute('href'),
				target: link.getAttribute('target'),
				rel: link.getAttribute('rel'),
				box: box(link),
				fontSize: style.fontSize,
				// A nowrap label that does not fit its own box would clip or push past it here.
				clipped:
					link.scrollWidth > link.clientWidth + 1 || link.scrollHeight > link.clientHeight + 1,
			};
		});
		return {
			wrapper: box(wrapper),
			cell: box(wrapper.parentElement!),
			divider: {
				...box(divider),
				visible: divider.getClientRects().length > 0,
			},
			links,
			rootFont: getComputedStyle(document.documentElement).fontSize,
			footer: box(document.querySelector<HTMLElement>('[data-testid="footer"]')!),
			viewportWidth: window.innerWidth,
			scrollX: window.scrollX,
		};
	});

async function settled(page: Page) {
	await expect(cluster(page)).toBeVisible();
	await page.evaluate(async () => {
		await document.fonts.ready;
	});
	let last = await metrics(page);
	for (let attempt = 0; attempt < 30; attempt++) {
		await page.evaluate(
			() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
		);
		const now = await metrics(page);
		if (JSON.stringify(now) === JSON.stringify(last)) return now;
		last = now;
	}
	return last;
}

// Keyboard arrival. A key press sets the keyboard modality (see the caller), then each link takes
// focus and the browser reveals it: the link must match :focus-visible, draw its ring, and its own
// centre point must resolve to the link rather than chrome covering it. WebKit leaves links out of
// its sequential tab order, so this path focuses each link directly instead of pretending Tab is
// portable; Enter still proves keyboard activation.
async function expectKeyboardReachable(link: Locator, name: string) {
	await link.focus();
	await expect(link, `${name} takes focus`).toBeFocused();
	await expect(link, `${name} is on screen`).toBeInViewport();
	const focus = await link.evaluate((element) => {
		const rect = element.getBoundingClientRect();
		const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
		const style = getComputedStyle(element);
		return {
			visible: element.matches(':focus-visible'),
			outline: style.outlineStyle,
			width: parseFloat(style.outlineWidth),
			unobscured: hit === element || element.contains(hit),
		};
	});
	expect(focus.visible, `${name} :focus-visible`).toBe(true);
	expect(focus.outline, `${name} focus ring`).toBe('solid');
	expect(focus.width, `${name} ring width`).toBeGreaterThanOrEqual(2);
	expect(focus.unobscured, `${name} not covered`).toBe(true);
}

async function expectBrandKeyboardOrder(page: Page) {
	// A key press first: the page opens at the top, and focus then scrolls forward into the footer.
	await page.keyboard.press('Home');
	await expectKeyboardReachable(house(page), 'house');
	await expect(house(page)).toHaveText('yesid.');
	await expectKeyboardReachable(product(page), 'product');
	await expect(product(page)).toHaveText('transit');
}

test('footer links clear the expanded phone announcement through hydration', async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 900 });
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	await page.route('**/_app/immutable/**/*.js', async (route) => {
		await gate;
		await route.fallback();
	});
	try {
		await page.goto(localizeHref('/privacy', 'fr', 'octranspo'), { waitUntil: 'domcontentloaded' });
		await page.addStyleTag({ content: 'html { font-size: 200%; }' });
		await expect(page.locator('html[data-hydrated]')).toHaveCount(0);
		// WebKit's fonts.ready also waits for the document load held by the hydration gate.
		await expect
			.poll(() => page.evaluate(() => [...document.fonts].some((face) => face.status === 'loading')))
			.toBe(false);
		await page.keyboard.press('Home');
		const link = house(page);
		await expectKeyboardReachable(link, 'house');

		release();
		await expect(page.locator('html[data-hydrated]')).toHaveCount(1);
		await expect(page.locator('[data-announcement-measured]')).toHaveCount(
			announcement.enabled ? 1 : 0,
		);
		await expect(link).toBeFocused();
		const unobscured = await link.evaluate((element) => {
			const rect = element.getBoundingClientRect();
			const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
			return hit === element || element.contains(hit);
		});
		expect(unobscured, 'hydration keeps the already-focused house link clear').toBe(true);
		await expectKeyboardReachable(product(page), 'product');
	} finally {
		release();
	}
});

for (const brandCase of cases)
	test(`${brandCase.locale} ${brandCase.provider} ${brandCase.route} ${brandCase.width}px ${brandCase.scale}% footer brand holds its column`, async ({
		page,
	}) => {
		const { route, provider, locale, width, scale } = brandCase;
		await page.setViewportSize({ width, height: 900 });
		await page.goto(localizeHref(route, locale, provider));
		if (scale === 200) {
			// Text scaling is an input: raise the root and assert the computed size it lands on.
			await page.addStyleTag({ content: 'html { font-size: 200%; }' });
			await expect
				.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).fontSize))
				.toBe('32px');
		}

		const measured = await settled(page);
		const [houseLink, productLink] = measured.links;

		// Text size is an input, not a consequence: assert the emulated root it scales from.
		expect(measured.rootFont, 'root font').toBe(scale === 200 ? '32px' : '16px');
		expect(measured.links, 'brand links').toHaveLength(2);
		expect(houseLink!.text).toBe('yesid.');
		expect(productLink!.text).toBe('transit');
		expect(houseLink!.href).toBe('https://yesid.dev');
		expect(houseLink!.target).toBe('_blank');
		expect(houseLink!.rel).toBe('noopener noreferrer');
		expect(productLink!.href).toBe(localizeHref('/', locale, provider));
		expect(houseLink!.fontSize, 'house font').toBe(scale === 200 ? '36px' : '18px');
		expect(productLink!.fontSize, 'product font').toBe(scale === 200 ? '48px' : '24px');
		expect([houseLink!.box.height, productLink!.box.height], 'link heights').toEqual(
			scale === 200 ? [56, 64] : [44, 44],
		);
		expect([houseLink!.clipped, productLink!.clipped], 'labels clip').toEqual([false, false]);

		// The wrapper fills the column the footer gives it and never leaves the page's width.
		expect(
			Math.abs(measured.wrapper.width - measured.cell.width),
			'wrapper fills column',
		).toBeLessThanOrEqual(1);
		expect(measured.wrapper.left).toBeGreaterThanOrEqual(measured.cell.left - 1);
		expect(measured.wrapper.right).toBeLessThanOrEqual(measured.cell.right + 1);
		for (const [name, link] of [
			['house', houseLink!],
			['product', productLink!],
		] as const) {
			expect(link.box.left, `${name} inside column`).toBeGreaterThanOrEqual(
				measured.wrapper.left - 1,
			);
			expect(link.box.right, `${name} inside column`).toBeLessThanOrEqual(
				measured.wrapper.right + 1,
			);
			expect(link.box.left, `${name} inside viewport`).toBeGreaterThanOrEqual(0);
			expect(link.box.right, `${name} inside viewport`).toBeLessThanOrEqual(measured.viewportWidth);
			expect(link.box.height, `${name} target`).toBeGreaterThanOrEqual(44);
			expect(link.box.width, `${name} target`).toBeGreaterThanOrEqual(44);
		}
		expect(measured.scrollX).toBe(0);
		expect(measured.footer.left).toBeGreaterThanOrEqual(0);
		expect(measured.footer.right).toBeLessThanOrEqual(measured.viewportWidth + 0.5);

		const stacked = scale === 200;
		if (stacked) {
			// 200% text in a phone column: stacked in reading order, start aligned.
			expect(productLink!.box.top, 'product below house').toBeGreaterThanOrEqual(
				houseLink!.box.bottom - 0.5,
			);
			expect(
				Math.abs(productLink!.box.left - houseLink!.box.left),
				'start aligned',
			).toBeLessThanOrEqual(1);
			expect(measured.divider.visible, 'decorative divider steps out').toBe(false);
		} else {
			// 100% text keeps today's row: one line, centred, with the kit's default split space.
			expect(
				Math.abs(linkCentre(houseLink!.box) - linkCentre(productLink!.box)),
				'row centred',
			).toBeLessThanOrEqual(1);
			expect(productLink!.box.left, 'product follows house').toBeGreaterThan(houseLink!.box.right);
			expect(measured.divider.visible, 'divider splits the row').toBe(true);
			expect(measured.divider.width, 'divider width').toBe(2);
			expect(measured.divider.height, 'divider height').toBe(18);

			const before = measured.divider.left - houseLink!.box.right;
			const after = productLink!.box.left - measured.divider.right;
			expect(Math.abs(before - 8), 'house split space').toBeLessThanOrEqual(0.5);
			expect(Math.abs(after - 8), 'product split space').toBeLessThanOrEqual(0.5);
			expect(Math.abs(before - after), 'equal split spaces').toBeLessThanOrEqual(0.01);
		}

		// One wide ordinary case also proves the public split-space token reaches both gaps.
		if (width === 1280 && locale === 'en' && provider === 'stm') {
			// The footer is server-rendered and the app writes its style attribute again while it
			// hydrates; wait for that before supplying the contract input, or the write is replaced.
			await expect(page.locator('.nav-pill.nav-hydrated')).toBeVisible();
			await page
				.getByTestId('footer')
				.evaluate((footer) => footer.style.setProperty('--nav-split-space', '12px'));
			const row = cluster(page);
			await expect
				.poll(() => row.evaluate((element) => getComputedStyle(element).gap))
				.toBe('12px');
			const tokenized = await settled(page);
			const [tokenHouse, tokenProduct] = tokenized.links;
			const before = tokenized.divider.left - tokenHouse!.box.right;
			const after = tokenProduct!.box.left - tokenized.divider.right;
			expect([before, after], 'token split spaces').toEqual([12, 12]);
		}

		// Both links are keyboard reachable, visible on focus and not covered by other chrome.
		await expectBrandKeyboardOrder(page);

		// A representative narrow Privacy case also proves the product link goes home.
		if (route === '/privacy' && locale === 'en' && provider === 'stm' && scale === 200) {
			await expect(product(page)).toBeFocused();
			await page.keyboard.press('Enter');
			await expect
				.poll(() => {
					const url = new URL(page.url());
					return url.pathname + url.search;
				})
				.toBe(localizeHref('/', locale, provider));
		}
	});

function linkCentre(box: Box) {
	return box.top + box.height / 2;
}
