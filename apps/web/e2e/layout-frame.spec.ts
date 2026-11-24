import { expect, type Page } from '@playwright/test';
import { localizeHref } from '../src/lib/i18n/routing';
import { navPillCopy } from '../src/lib/i18n/messages';
import { test } from './layout-test';

const cities = {
	stm: {
		en: 'Source: Société de transport de Montréal (STM), CC BY 4.0.',
		fr: 'Source : Société de transport de Montréal (STM), CC BY 4.0.',
	},
	octranspo: {
		en: 'Contains information licensed under the Open Government Licence – City of Ottawa.',
		fr: 'Contient de l’information visée par la Licence du gouvernement ouvert – Ville d’Ottawa.',
	},
};

async function open(page: Page, href: string) {
	await page.goto(href);
	await expect(page.locator('html[data-hydrated]')).toHaveCount(1);
}

for (const locale of ['en', 'fr'] as const) {
	const words = navPillCopy[locale];
	test(`${locale} compact header reaches the city after the menu and clears the content`, async ({
		page,
		browserName,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await open(page, localizeHref('/lines', locale, 'stm'));
		const site = page.getByTestId('nav-pill');
		const menu = site.getByTestId('nav-menu-toggle');
		const city = site.getByRole('combobox', { name: words.network });
		await expect(city).toBeVisible();
		await expect(site.getByTestId('theme-toggle')).toBeVisible();
		await expect(site.getByTestId('language-toggle')).toBeVisible();
		expect((await page.getByRole('main').boundingBox())!.y).toBeLessThanOrEqual(140);
		// WebKit does not Tab between all native controls in its default keyboard mode.
		if (browserName === 'chromium') {
			await menu.focus();
			await page.keyboard.press('Tab');
			await expect(city).toBeFocused();
		}
	});

	test(`${locale} city select provides a 44px activation target`, async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await open(page, localizeHref('/lines', locale, 'stm'));
		const city = page.getByTestId('nav-pill').getByRole('combobox', { name: words.network });
		expect((await city.boundingBox())!.height).toBeGreaterThanOrEqual(44);
	});

	test(`${locale} inline search and city fit at 1024px and 200% text`, async ({ page }) => {
		await page.setViewportSize({ width: 1024, height: 900 });
		await open(page, localizeHref('/privacy', locale, 'stm'));
		await page.addStyleTag({ content: 'html { font-size: 200%; }' });
		await page.evaluate(() => document.fonts.ready);
		const pill = page.getByTestId('nav-pill');
		await expect(pill.getByRole('combobox', { name: words.searchAria.all })).toBeVisible();
		await expect(pill.getByRole('combobox', { name: words.network })).toBeVisible();
		const bounds = (await pill.boundingBox())!;
		expect(bounds.x).toBeGreaterThanOrEqual(0);
		expect(bounds.x + bounds.width).toBeLessThanOrEqual(1024);
	});

	for (const [city, licences] of Object.entries(cities)) {
		test(`${locale} ${city} credits the source on Record, Live and Map pages`, async ({ page }) => {
			for (const href of ['/', '/?frameMode=live', '/map']) {
				await open(page, localizeHref(href, locale, city));
				const credit = page.locator(
					'footer :is([data-slot="source-credit"]), footer[data-slot="map-source-footer"]',
				);
				await expect(credit).toHaveText(licences[locale]);
			}
			await open(page, localizeHref('/privacy', locale, city));
			const legal = page.getByTestId('footer');
			await expect(legal).not.toContainText(licences[locale]);
			await expect(legal.locator('[data-slot="source-credit"]')).toHaveCount(0);
		});
	}
}

test('desktop controls keep their column and control changes retain focus and scroll', async ({
	page,
	browserName,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await open(page, '/?provider=stm');
	const rail = page.getByRole('complementary', { name: 'Controls', exact: true });
	expect((await rail.boundingBox())!.width).toBe(272);
	const main = page.getByRole('main');
	const x = (await main.boundingBox())!.x;
	if (browserName === 'chromium') {
		const search = page
			.getByTestId('nav-pill')
			.getByRole('combobox', { name: navPillCopy.en.searchAria.all });
		await search.focus();
		await page.keyboard.press('Tab');
		await expect(
			page.getByTestId('nav-pill').getByRole('combobox', { name: navPillCopy.en.network }),
		).toBeFocused();
	}
	const menu = page.getByTestId('nav-menu-toggle');
	await menu.click();
	await page
		.getByRole('dialog', { name: navPillCopy.en.menu })
		.locator('[data-slot="menu-group"]')
		.getByRole('link', { name: 'Lines', exact: true })
		.click();
	await expect(page).toHaveURL(/\/lines\?/);
	await expect(main).toBeFocused();
	expect(await page.evaluate(() => window.scrollY)).toBe(0);
	expect((await main.boundingBox())!.x).toBe(x);

	await expect(rail.getByRole('radio', { name: 'Live now', exact: true })).toBeDisabled();
	await expect(rail.getByText('This screen is a record. It has no live view.')).toBeVisible();
	const preset = rail.getByRole('radio', { name: '28 days', exact: true });
	await preset.focus();
	await page.evaluate(() => window.scrollTo(0, 250));
	const scroll = await page.evaluate(() => window.scrollY);
	expect(scroll).toBeGreaterThan(0);
	await page.keyboard.press('Space');
	await expect(page).toHaveURL(/period=28-days/);
	await expect(preset).toBeFocused();
	expect(await page.evaluate(() => window.scrollY)).toBe(scroll);
	await expect(rail.locator('[data-slot="frame-period-summary"]')).toContainText('28 days');
});

test('phone controls open a sheet and return focus to the pill', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await open(
		page,
		'/fr/lines?provider=stm&period=7-days&recordFrom=2026-11-08&recordTo=2026-11-14',
	);
	const pill = page.getByRole('button', { name: /^Commandes 7 jours.*Ouvrir les commandes/ });
	await pill.focus();
	await page.keyboard.press('Enter');
	const sheet = page.getByRole('dialog', { name: 'Commandes', exact: true });
	await expect(sheet).toBeVisible();
	await expect(sheet.getByRole('radio', { name: 'En direct', exact: true })).toBeDisabled();
	await expect(sheet.getByRole('radio', { name: '12 mois', exact: true })).toBeVisible();
	await expect(sheet.locator('[data-slot="frame-period-summary"]')).toContainText(
		'du 8 au 14 nov. 2026',
	);
	await page.keyboard.press('Escape');
	await expect(sheet).toBeHidden();
	await expect(pill).toBeFocused();
});
