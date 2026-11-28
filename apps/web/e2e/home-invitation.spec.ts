import { expect, test, type Page } from '@playwright/test';
import { overviewCopy } from '../src/lib/features/home/overviewRecord.copy';
import { roadmapLinks } from '../src/lib/features/roadmap/roadmap.copy';

test.beforeEach(({ browserName }, info) => {
	test.skip(browserName !== 'chromium' || info.project.name !== 'desktop');
});

const period = 'recordFrom=2026-11-08&recordTo=2026-11-14';
const home = (locale: 'en' | 'fr') =>
	`${locale === 'fr' ? '/fr' : ''}/?provider=stm&frameMode=record&${period}`;

async function open(page: Page, locale: 'en' | 'fr') {
	await page.goto(home(locale));
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
	await expect(page.locator('[data-slot="record-ranking"] tbody tr').first()).toBeVisible();
}

const props = (page: Page) => page.locator('[data-slot="construction-props"]');
const floorHeight = (page: Page) =>
	page
		.locator('.home-construction-floor')
		.evaluate((floor) => floor.getBoundingClientRect().height);
/** The footer's place in the page, which the reveal must never move. */
const footerTop = (page: Page) =>
	page
		.getByTestId('footer')
		.evaluate((footer) => Math.round(footer.getBoundingClientRect().top + window.scrollY));
/** How far each prop's artwork sits below its resting place, in px. */
const lifts = (page: Page) =>
	page
		.locator('[data-construction-prop] > svg')
		.evaluateAll((all) => all.map((svg) => new DOMMatrix(getComputedStyle(svg).transform).m42));
const progress = (page: Page) =>
	props(page).evaluate((el) => Number(el.getAttribute('data-progress')));

/** Scroll so the ground's marker sits at `share` of the viewport height. */
async function placeMarker(page: Page, share: number) {
	await page.evaluate((share) => {
		const marker = document.querySelector('.construction-anchor')!;
		const top = marker.getBoundingClientRect().top + window.scrollY;
		window.scrollTo(0, top - innerHeight * share);
	}, share);
}

for (const locale of ['en', 'fr'] as const) {
	const copy = overviewCopy[locale];

	test(`${locale}: the Overview says what Transit is and ends with the invitation, then the props`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await open(page, locale);
		await expect(page.locator('[data-screen-intro]')).toHaveText(
			copy.intro(locale === 'fr' ? 'Montréal et Ottawa' : 'Montréal and Ottawa'),
		);
		// Today's answer stays above the fold under the introduction.
		const answer = page.locator('[data-slot="screen-answer"] .metric-value').first();
		await expect(answer).toBeInViewport({ ratio: 1 });

		const invitation = page.getByRole('article', { name: copy.contribute.title, exact: true });
		await expect(invitation).toContainText(copy.contribute.lead);
		await expect(invitation).toContainText(copy.contribute.thanks);
		const links = invitation.getByRole('link');
		await expect(links).toHaveText([
			copy.errorRow,
			copy.contribute.citeLink,
			copy.contribute.codeLink,
			copy.contribute.cityLink,
		]);
		const [error, download, code, city] = await links.evaluateAll((anchors) =>
			anchors.map((anchor) => (anchor as HTMLAnchorElement).href),
		);
		const prefix = locale === 'fr' ? '/fr' : '';
		expect(new URL(error).pathname + new URL(error).hash).toBe(`${prefix}/metrics#about-transit`);
		expect(new URL(error).searchParams.get('provider')).toBe('stm');
		expect(new URL(download).pathname).toBe(`${prefix}/download`);
		expect(code).toBe(roadmapLinks.code);
		expect(city).toBe(roadmapLinks.contact[locale]);

		// The invitation is the last card; the props stand after it, just above the footer.
		const order = await page.evaluate(() => {
			const cards = [...document.querySelectorAll('main [data-slot="record-card"]')];
			const last = cards.at(-1)!;
			const floor = document.querySelector('.home-construction-floor')!;
			const footer = document.querySelector('[data-testid="footer"]')!;
			return {
				lastIsInvitation: !!last.querySelector('[data-slot="overview-contribute"]'),
				floorAfterCards: !!(last.compareDocumentPosition(floor) & Node.DOCUMENT_POSITION_FOLLOWING),
				floorBeforeFooter: !!(
					floor.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING
				),
			};
		});
		expect(order).toEqual({
			lastIsInvitation: true,
			floorAfterCards: true,
			floorBeforeFooter: true,
		});
	});
}

test('the props rise with the scroll at their live sizes, and sink back', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await page.setViewportSize({ width: 1440, height: 900 });
	await open(page, 'en');
	// Far above the ground: nothing shows, yet the ground already holds its full height.
	await expect(props(page)).toHaveAttribute('data-state', 'hidden');
	expect(await floorHeight(page)).toBe(240);
	const footer = await footerTop(page);

	// Halfway through the reveal (marker at 95% minus half of 25% of the viewport): the props are
	// half risen inside the ground, and nothing outside it has moved.
	await placeMarker(page, 0.95 - 0.125);
	await expect(props(page)).toHaveAttribute('data-state', 'revealing');
	await expect.poll(() => progress(page)).toBeGreaterThan(0.3);
	expect(await progress(page)).toBeLessThan(0.7);
	const half = await lifts(page);
	expect(Math.min(...half)).toBeGreaterThan(0);
	expect([await floorHeight(page), await footerTop(page)]).toEqual([240, footer]);

	await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
	await expect(props(page)).toHaveAttribute('data-state', 'visible');
	expect(await lifts(page)).toEqual(half.map(() => 0));
	expect([await floorHeight(page), await footerTop(page)]).toEqual([240, footer]);
	const widths = await page
		.locator('[data-construction-prop]')
		.evaluateAll((all) =>
			Object.fromEntries(
				all.map((el) => [
					el.getAttribute('data-construction-prop'),
					el.getBoundingClientRect().width,
				]),
			),
		);
	expect(widths).toEqual({ sign: 167, helmet: 60, barricade: 200, balise: 156 });

	await page.evaluate(() => window.scrollTo(0, 0));
	await expect(props(page)).toHaveAttribute('data-state', 'hidden');
	expect(await footerTop(page)).toBe(footer);
});

for (const width of [320, 390] as const) {
	test(`the props fit a ${width} px phone without sideways scroll`, async ({ page }) => {
		await page.emulateMedia({ reducedMotion: 'no-preference' });
		await page.setViewportSize({ width, height: 844 });
		await open(page, 'fr');
		await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
		await expect(props(page)).toHaveAttribute('data-state', 'visible');
		expect(await floorHeight(page)).toBe(100);
		const fit = await page.evaluate(() => ({
			overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
			outside: [...document.querySelectorAll('[data-construction-prop]')].filter((el) => {
				const { left, right } = el.getBoundingClientRect();
				return left < 0 || right > document.documentElement.clientWidth;
			}).length,
		}));
		expect(fit).toEqual({ overflow: 0, outside: 0 });
	});
}

test('with reduced motion the props appear at once and never slide', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.setViewportSize({ width: 1440, height: 900 });
	await open(page, 'en');
	await expect(props(page)).toHaveAttribute('data-state', 'hidden');
	const footer = await footerTop(page);
	// Where the moving scene would be half revealed, the reduced scene is already whole, in place.
	await placeMarker(page, 0.95 - 0.125);
	await expect(props(page)).toHaveAttribute('data-state', 'visible');
	expect(await progress(page)).toBe(1);
	expect([await floorHeight(page), await footerTop(page)]).toEqual([240, footer]);
	const transforms = await page
		.locator('[data-construction-prop] > svg')
		.evaluateAll((all) => all.map((svg) => getComputedStyle(svg).transform));
	expect(new Set(transforms)).toEqual(new Set(['none']));
	await placeMarker(page, 1.2);
	await expect(props(page)).toHaveAttribute('data-state', 'hidden');
	expect(await progress(page)).toBe(0);
});

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
	test(`a footer link reached by keyboard stays in view while the ground opens (${reducedMotion})`, async ({
		page,
	}) => {
		await page.emulateMedia({ reducedMotion });
		await page.setViewportSize({ width: 1280, height: 900 });
		await open(page, 'en');
		// The footer stays hidden while a card's reading is still on its way (AppShell's streaming
		// footer), and a hidden link cannot take focus: wait for every card, as a reader does.
		await expect(page.getByRole('main').locator('[data-record-pending]')).toHaveCount(0);
		const house = page
			.getByTestId('footer-brand')
			.locator('[data-slot="product-brand"] a[data-slot="wordmark"]');
		await expect(house).toBeVisible();
		await page.keyboard.press('Home');
		await house.focus();
		await expect(house).toBeFocused();
		await expect(props(page)).toHaveAttribute('data-state', 'visible');
		await expect(house).toBeInViewport({ ratio: 1 });
		expect(
			await house.evaluate((link) => {
				const { left, top, width, height } = link.getBoundingClientRect();
				const hit = document.elementFromPoint(left + width / 2, top + height / 2);
				return hit === link || link.contains(hit);
			}),
		).toBe(true);
	});
}
