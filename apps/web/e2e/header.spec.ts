import { expect, test, type Page } from '@playwright/test';

import { navPillCopy } from '../src/lib/i18n/messages';
import {
	AUDIT_NAV,
	SURFACE_NAV,
	FRAME_MENU,
	NAV_GROUPS,
	FOOTER_INFO_NAV,
} from '../src/lib/content/nav';
import { DEFAULT_LOCALE, PUBLISHED_LOCALES, type Locale } from '../src/lib/i18n/config';
import { localizeHref } from '../src/lib/i18n/routing';

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const destinations = FRAME_MENU;
// Transit prefixes every locale but the default.
const localized = (href: string, locale: Locale) =>
	locale === DEFAULT_LOCALE ? href : `/${locale}${href}`;
const home = (locale: Locale) => (locale === DEFAULT_LOCALE ? '/' : `/${locale}`);
// Pin the fixture network rather than accepting the local Worker's approximate location.
const start = (locale: Locale) => localizeHref('/lines', locale, 'stm');
const next = (locale: Locale) =>
	PUBLISHED_LOCALES[(PUBLISHED_LOCALES.indexOf(locale) + 1) % PUBLISHED_LOCALES.length];
const samePath = (href: string) => (url: URL) => url.pathname === new URL(href, url).pathname;

// SSR shows the toggle before hydration wires it; retry the click until the menu opens.
async function openMenu(page: Page, locale: Locale) {
	const menu = page.getByRole('navigation', { name: navPillCopy[locale].menu });
	await expect(async () => {
		if (!(await menu.isVisible()))
			await page.getByRole('button', { name: navPillCopy[locale].openMenu }).click();
		await expect(menu).toBeVisible({ timeout: 1000 });
	}).toPass();
	return menu;
}

// No request leaves the machine: the app and its data fixture are both local.
test.beforeEach(async ({ page }) => {
	await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
});

for (const redirected of [false, true]) {
	test(`Kit 3 hook fallback ${redirected ? 'closes a redirected' : 'preserves a direct'} language switch`, async ({
		page,
	}) => {
		await page.goto('/privacy');
		await openMenu(page, 'en');
		const language = page.getByTestId('language-toggle');
		await expect(language).toHaveAttribute('data-sveltekit-reload', 'true');
		// Production keeps reload links. Exercise the native router hooks independently
		// of document departure, as in yesid.dev's Kit 3 header regression specs.
		await language.evaluate((link) => link.removeAttribute('data-sveltekit-reload'));
		if (redirected) {
			await page.route('**/fr/privacy/__data.json*', (route) =>
				route.fulfill({
					contentType: 'application/json',
					body: JSON.stringify({ type: 'redirect', location: '/fr/terms?provider=stm' }),
				}),
			);
		}
		await language.click();
		await expect(page).toHaveURL(samePath(redirected ? '/fr/terms' : '/fr/privacy'));
		await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
		if (redirected) {
			await expect(page.getByRole('dialog')).toHaveCount(0);
			await expect(language).not.toBeFocused();
		} else {
			await expect(page.getByRole('navigation', { name: navPillCopy.fr.menu })).toBeVisible();
			await expect(language).toBeFocused();
			await page.keyboard.press('Escape');
			await expect(page.getByRole('dialog')).toHaveCount(0);
			await expect(page.getByRole('button', { name: navPillCopy.fr.openMenu })).toBeFocused();
		}
	});
}

for (const locale of PUBLISHED_LOCALES) {
	const copy = navPillCopy[locale];
	test(`${locale}: the menu lists its destinations in four groups`, async ({ page }) => {
		await page.goto(start(locale));
		const menu = await openMenu(page, locale);
		for (const group of NAV_GROUPS) {
			await expect(
				menu.getByRole('heading', { name: group.label[locale], exact: true }),
			).toBeVisible();
			await expect(
				menu.getByRole('list', { name: group.label[locale], exact: true }),
			).toBeVisible();
		}
		for (const [index, item] of destinations.entries()) {
			await expect(menu.getByRole('link').nth(index)).toHaveAccessibleName(item.label[locale]);
		}
		await expect(menu.getByRole('link')).toHaveCount(destinations.length);
	});
	for (const item of [...SURFACE_NAV, ...AUDIT_NAV, ...FOOTER_INFO_NAV]) {
		test(`${locale}: the footer link to ${item.href} still answers`, async ({ page }) => {
			await page.goto(start(locale));
			await page
				.getByTestId('footer')
				.getByRole('link', { name: item.label[locale], exact: true })
				.click();
			await expect(page).toHaveURL(samePath(localized(item.href, locale)));
			await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
		});
	}
	test(`${locale}: the app menu keeps Service alerts for a network with no feed`, async ({
		page,
	}) => {
		await page.goto(localizeHref(AUDIT_NAV[0].href, locale, 'octranspo'));
		const menu = await openMenu(page, locale);
		const name = destinations.find((item) => item.key === 'alerts')!.label[locale];
		await expect(menu.getByRole('link', { name, exact: true })).toHaveCount(1);
		await expect(page.getByTestId('footer').getByRole('link', { name, exact: true })).toHaveCount(
			0,
		);
	});

	test(`${locale}: the language switch round-trips from home`, async ({ page }) => {
		await page.goto(home(locale));
		for (const from of [locale, next(locale)]) {
			await page
				.getByRole('link', { name: new RegExp(`^${literal(navPillCopy[from].language)}\\s?:`) })
				.click();
			await expect(page.locator('html')).toHaveAttribute('lang', next(from));
			await expect(page).toHaveURL(samePath(home(next(from))));
		}
	});

	test(`${locale}: every menu destination shows an icon and only the current one is lit`, async ({
		page,
	}) => {
		await page.goto(start(locale));
		const menu = await openMenu(page, locale);
		for (const item of destinations) {
			const icon = menu.getByRole('link', { name: item.label[locale], exact: true }).locator('svg');
			await expect(icon).toBeVisible();
			if (item.key === 'lines') await expect(icon).not.toHaveCSS('fill', 'none');
			else await expect(icon).toHaveCSS('fill', 'none');
		}
	});

	test(`${locale}: the menu lists every destination, holds focus and gives it back on Escape`, async ({
		page,
	}) => {
		await page.goto(start(locale));
		const menu = await openMenu(page, locale);

		for (const item of destinations) {
			await expect(menu.getByRole('link', { name: item.label[locale], exact: true })).toBeVisible();
		}
		await expect(page.getByRole('button', { name: copy.closeMenu })).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(page.getByRole('dialog', { name: copy.menu }).locator(':focus')).toHaveCount(1);

		await page.keyboard.press('Escape');
		await expect(menu).toBeHidden();
		await expect(page.getByRole('button', { name: copy.openMenu })).toBeFocused();
	});

	test(`${locale}: a menu destination navigates and closes the menu`, async ({ page }) => {
		const target = destinations.at(-1)!;
		await page.goto(start(locale));
		const menu = await openMenu(page, locale);
		await menu.getByRole('link', { name: target.label[locale], exact: true }).click();

		await expect(page).toHaveURL(samePath(localized(target.href, locale)));
		await expect(menu).toBeHidden();
	});

	test(`${locale}: the language switch loads the other locale`, async ({ page }) => {
		await page.goto(start(locale));
		await page.getByRole('link', { name: new RegExp(`^${literal(copy.language)}\\s?:`) }).click();

		await expect(page).toHaveURL(samePath(start(next(locale))));
		await expect(page.locator('html')).toHaveAttribute('lang', next(locale));
	});

	test(`${locale}: the header fits the viewport and the city label is centred in its control`, async ({
		page,
	}) => {
		await page.goto(start(locale));
		const projectWidth = page.viewportSize()!;
		// The brand cluster is widest relative to the room on the narrowest phone.
		for (const width of [320, projectWidth.width]) {
			await page.setViewportSize({ width, height: projectWidth.height });
			const pill = (await page.getByTestId('nav-pill').boundingBox())!;
			expect(pill.x, `pill start at ${width}px`).toBeGreaterThanOrEqual(0);
			expect(pill.x + pill.width, `pill end at ${width}px`).toBeLessThanOrEqual(width);
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
				width,
			);
		}

		// Check the visible trigger content, including the kit's decorative chevron when present.
		const scope = page.locator('[data-slot="site-header-network"]');
		const control = scope.getByRole('combobox', { name: copy.network });
		const box = (await control.boundingBox())!;
		const trigger = scope.locator('label', {
			has: page.getByRole('combobox', { name: copy.network }),
		});
		const label = (await trigger.getByText(/\S/).filter({ visible: true }).boundingBox())!;
		const chevron = trigger.locator('svg:visible');
		const icon = (await chevron.count()) ? await chevron.boundingBox() : null;
		const left = Math.min(label.x, icon?.x ?? label.x);
		const right = Math.max(label.x + label.width, icon ? icon.x + icon.width : label.x);
		expect(Math.abs(box.x + box.width / 2 - (left + right) / 2)).toBeLessThanOrEqual(1);
		expect(Math.abs(box.y + box.height / 2 - (label.y + label.height / 2))).toBeLessThanOrEqual(1);
	});
}

// WCAG 3.2.2: arrow keys on the city picker never change the page; Enter does.
for (const locale of PUBLISHED_LOCALES)
	test(`${locale} city picker previews on arrow keys and switches only on Enter`, async ({ page }, {
		project,
	}) => {
		test.skip(project.name !== 'desktop', 'one keyboard walk on the desktop header');
		const words = navPillCopy[locale];
		const confirm = { en: 'Press Enter to switch to', fr: 'Appuyez sur Entrée pour passer à' }[
			locale
		];
		await page.goto(start(locale));
		await expect(page.locator('html[data-hydrated]')).toHaveCount(1);
		const choice = page.locator('[data-slot="network-choice"]');
		const city = choice.getByRole('combobox', { name: new RegExp(words.network) });
		const status = choice.getByRole('status');
		await city.focus();
		for (const key of ['ArrowUp', 'ArrowDown', 'ArrowUp']) {
			await page.keyboard.press(key);
			await expect(city).toBeFocused();
		}
		await expect(page).toHaveURL((url) => url.searchParams.get('provider') === 'stm');
		await expect(city).toHaveValue('octranspo');
		await expect(status).toHaveText(`${confirm} Ottawa · OC Transpo.`);
		await page.keyboard.press('Escape');
		await expect(city).toHaveValue('stm');
		await expect(status).toHaveText('');
		await page.keyboard.press('ArrowUp');
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL((url) => url.searchParams.get('provider') === 'octranspo');
	});

test('the kit network changes on legal pages and custom dates change a record route', async ({
	page,
}) => {
	await page.goto('/privacy?provider=stm');
	await expect(page.locator('html[data-hydrated]')).toHaveCount(1);
	const controls = page.locator('[data-slot="site-header-network"]');
	const network = controls.locator('[data-slot="network-picker"]').getByRole('combobox');
	await expect(network).toHaveValue('stm');
	await network.selectOption('octranspo');
	await expect(page).toHaveURL((url) => url.searchParams.get('provider') === 'octranspo');
	await expect(
		page.locator('[data-slot="surface-rail"], [data-slot="surface-rail-mobile"]'),
	).toHaveCount(0);
	await page.goto('/network?provider=octranspo&frameMode=record');
	await expect(page.locator('html[data-hydrated]')).toHaveCount(1);
	if (page.viewportSize()!.width < 1024) {
		await page.getByRole('button', { name: /^Controls.*Open controls/ }).click();
	}
	await page.getByRole('button', { name: 'Choose other dates', exact: true }).click();
	const dialog = page.getByRole('dialog', {
		name: page.viewportSize()!.width >= 768 ? 'Choose dates' : 'Period',
		exact: true,
	});
	const dates = dialog.locator('[data-slot="date-range-picker"]');
	await dates.getByLabel('From', { exact: true }).fill('2026-10-20');
	await dates.getByLabel('To', { exact: true }).fill('2026-10-21');
	await dates.getByRole('button', { name: 'Show these dates' }).click();
	await expect(page).toHaveURL(
		(url) =>
			url.pathname === '/network' &&
			url.searchParams.get('provider') === 'octranspo' &&
			url.searchParams.get('recordFrom') === '2026-10-20' &&
			url.searchParams.get('recordTo') === '2026-10-21',
	);
});
