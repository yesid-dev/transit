import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

import { navPillCopy } from '../src/lib/i18n/messages';
import { headerSearchCopy } from '../src/lib/components/shell/headerSearch.copy';
import { PUBLISHED_LOCALES } from '../src/lib/i18n/config';
import { localizeHref } from '../src/lib/i18n/routing';

const [line, other] = JSON.parse(
	readFileSync(new URL('./routes-index.json', import.meta.url), 'utf8'),
).routes;
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test.use({ bypassCSP: true });

test.beforeEach(async ({ page }, { project }) => {
	test.skip(project.name === 'desktop', 'from 1280px the field sits in the header itself');
	await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
});

for (const locale of PUBLISHED_LOCALES) {
	const name = navPillCopy[locale].searchAria.all;
	const words = headerSearchCopy[locale];
	const trigger = (page: Page) => page.getByRole('button', { name, exact: true });
	const sheet = (page: Page) => page.getByRole('dialog', { name: words.sheetTitle });
	const home = localizeHref('/', locale, 'stm');
	const start = localizeHref(`/lines/${other.id}`, locale, 'stm');
	const row = new RegExp(`^${literal(`${words.kind.route} ${line.short} · ${line.long}`)}`);
	const startingHeading = locale === 'fr' ? 'Ligne 1 Confederation' : 'Line 1 Confederation';
	const selectedHeading = locale === 'fr' ? 'Ligne 24 Sherbrooke' : 'Line 24 Sherbrooke';
	const entries = (page: Page) => page.evaluate(() => history.length);

	async function openSheet(page: Page, label = name) {
		await page.getByRole('button', { name: label, exact: true }).click();
		const field = sheet(page).getByRole('combobox', { name: label });
		await expect(field).toBeFocused();
		return field;
	}

	test(`${locale}: a line chosen in the sheet opens its page, and one Back shows the line it left`, async ({
		page,
	}) => {
		const title = page.getByRole('heading', { level: 1 });
		await page.goto(start);
		await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
		await expect(title).toHaveText(startingHeading);
		const length = await entries(page);
		const field = await openSheet(page);
		// Modal: the header and the page behind the sheet are inert.
		await expect(page.locator('[data-slot="app-frame"]')).toHaveAttribute('inert', '');
		await field.fill(line.long);
		await sheet(page).getByRole('option', { name: row }).click();
		await expect(title).toHaveText(selectedHeading);
		await expect(sheet(page)).toBeHidden();
		await expect(page.locator('[data-slot="app-frame"]')).not.toHaveAttribute('inert');
		expect(await entries(page)).toBe(length + 1);
		// One Back shows the page the search began on, not only its URL.
		await page.goBack();
		await expect(page).toHaveURL((url) => url.pathname + url.search === start);
		await expect(title).toHaveText(startingHeading);
		await expect(sheet(page)).toBeHidden();
	});

	test(`${locale}: Escape and Back close the sheet and give focus back to its button`, async ({
		page,
	}) => {
		await page.goto(home);
		await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
		const field = await openSheet(page);
		await field.fill(line.long);
		await page.keyboard.press('Escape');
		await expect(sheet(page)).toBeHidden();
		await expect(trigger(page)).toBeFocused();
		// The text waits for the next opening.
		await expect(await openSheet(page)).toHaveValue(line.long);
		await page.goBack();
		await expect(sheet(page)).toBeHidden();
		await expect(page).toHaveURL((url) => url.pathname + url.search === home);
		await expect(trigger(page)).toBeFocused();
	});

	test(`${locale}: Forward reopens the sheet, Close goes back once, and Enter on a line keeps one Back`, async ({
		page,
	}) => {
		const title = page.getByRole('heading', { level: 1 });
		const field = sheet(page).getByRole('combobox', { name });
		await page.goto(start);
		await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
		const length = await entries(page);
		await (await openSheet(page)).fill(line.long);
		await page.goBack();
		await expect(sheet(page)).toBeHidden();
		await page.goForward();
		await expect(field).toBeFocused();
		await expect(field).toHaveValue(line.long);
		await sheet(page).getByRole('button', { name: words.closeSheet, exact: true }).click();
		await expect(sheet(page)).toBeHidden();
		await expect(page.getByRole('button', { name, exact: true })).toBeFocused();
		await page.goForward();
		await expect(field).toBeFocused();
		// The full name is an exact match, so it is highlighted and Enter opens it.
		await expect(sheet(page).getByRole('option', { name: row })).toHaveAttribute(
			'aria-selected',
			'true',
		);
		await field.press('Enter');
		await expect(title).toHaveText(selectedHeading);
		expect(await entries(page)).toBe(length + 1);
		await page.goBack();
		await expect(page).toHaveURL((url) => url.pathname + url.search === start);
		await expect(title).toHaveText(startingHeading);
		await expect(sheet(page)).toBeHidden();
	});

	test(`${locale}: beside the page links the icon button opens the sheet and takes focus back`, async ({
		page,
	}, { project }) => {
		test.skip(project.name !== 'tablet', 'one run sets its own 1180px viewport');
		await page.setViewportSize({ width: 1180, height: 900 });
		await page.goto(home);
		await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
		await expect(page.getByTestId('nav-pill').locator('.nav-links a:visible')).toHaveCount(4);
		await expect(trigger(page)).toHaveAttribute('data-slot', 'nav-search-button');
		await expect(trigger(page)).toHaveText('');
		await expect(page.getByRole('combobox', { name })).toHaveCount(0);
		const field = await openSheet(page);
		await field.fill(line.long);
		await page.keyboard.press('Escape');
		await expect(sheet(page)).toBeHidden();
		await expect(trigger(page)).toBeFocused();
		await expect(await openSheet(page)).toHaveValue(line.long);
		await page.goBack();
		await expect(sheet(page)).toBeHidden();
		await expect(trigger(page)).toBeFocused();
		await page.goForward();
		await expect(field).toBeFocused();
	});

	test(`${locale}: Forward onto the sheet once the header has widened opens no hidden sheet`, async ({
		page,
	}) => {
		await page.goto(home);
		await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
		await openSheet(page);
		await page.goBack();
		await expect(sheet(page)).toBeHidden();
		await page.setViewportSize({ width: 1440, height: 900 });
		await expect(trigger(page)).toBeHidden();
		await page.goForward();
		// Let the restored entry reach the sheet before checking that nothing opened.
		await page.evaluate(() => new Promise((done) => setTimeout(done, 500)));
		await expect(sheet(page)).toBeHidden();
		await expect(page.locator('[data-slot="app-frame"]')).not.toHaveAttribute('inert');
		await expect(page.getByRole('combobox', { name })).toBeVisible();
	});
}

test('the search sheet finds a clean-only stop using an unaccented query', async ({ page }) => {
	const words = headerSearchCopy.fr;
	await page.goto(localizeHref('/stops', 'fr', 'stm'));
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
	await page.getByRole('button', { name: navPillCopy.fr.searchAria.all, exact: true }).click();
	const search = page.getByRole('dialog', { name: words.sheetTitle });
	const field = search.getByRole('combobox');
	await field.fill('cremazie clean');
	const option = search.getByRole('option', { name: /Crémazie Clean/ });
	await expect(option).toBeVisible();
	await expect(field).toHaveAttribute('aria-activedescendant', (await option.getAttribute('id'))!);
});
