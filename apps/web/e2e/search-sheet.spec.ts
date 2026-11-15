import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

import { navPillCopy } from '../src/lib/i18n/messages';
import { headerSearchCopy } from '../src/lib/components/shell/headerSearch.copy';
import { PUBLISHED_LOCALES } from '../src/lib/i18n/config';
import { localizeHref } from '../src/lib/i18n/routing';

const line = JSON.parse(readFileSync(new URL('./routes-index.json', import.meta.url), 'utf8'))
	.routes[0];
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test.use({ bypassCSP: true });

test.beforeEach(async ({ page }, { project }) => {
	test.skip(project.name === 'desktop', 'from 1024px the field sits in the header itself');
	await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
});

for (const locale of PUBLISHED_LOCALES) {
	const name = navPillCopy[locale].searchAria.all;
	const words = headerSearchCopy[locale];
	const trigger = (page: Page) => page.getByRole('button', { name, exact: true });
	const sheet = (page: Page) => page.getByRole('dialog', { name: words.sheetTitle });
	const home = localizeHref('/', locale);

	async function openSheet(page: Page) {
		await trigger(page).click();
		const field = sheet(page).getByRole('combobox', { name });
		await expect(field).toBeFocused();
		return field;
	}

	test(`${locale}: the search sheet finds a line and lands on its page; Back returns`, async ({
		page,
	}) => {
		await page.goto(home);
		await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
		const field = await openSheet(page);
		// Modal: the header and the page behind the sheet are inert.
		await expect(page.locator('[data-slot="app-shell-row"]')).toHaveAttribute('inert', '');
		await expect(page.locator('[data-slot="app-shell-chrome"]')).toHaveAttribute('inert', '');
		await field.fill(line.long);
		const row = new RegExp(`^${literal(`${words.kind.route} ${line.short} · ${line.long}`)}`);
		await sheet(page).getByRole('option', { name: row }).click();
		await expect(page).toHaveURL(
			(url) => url.pathname === localizeHref(`/lines/${line.id}`, locale),
		);
		await expect(sheet(page)).toBeHidden();
		await expect(page.locator('[data-slot="app-shell-row"]')).not.toHaveAttribute('inert');
		// The record took the sheet's history entry: one Back returns to where the search began.
		await page.goBack();
		await expect(page).toHaveURL((url) => url.pathname === home);
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
		await expect(page).toHaveURL((url) => url.pathname === home);
		await expect(trigger(page)).toBeFocused();
	});

	test(`${locale}: Forward reopens the sheet, Close goes back once, and no entry is added`, async ({
		page,
	}) => {
		const entries = () => page.evaluate(() => history.length);
		const field = sheet(page).getByRole('combobox', { name });
		await page.goto(home);
		await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
		await (await openSheet(page)).fill(line.long);
		const length = await entries();
		await page.goBack();
		await expect(sheet(page)).toBeHidden();
		await page.goForward();
		await expect(field).toBeFocused();
		await expect(field).toHaveValue(line.long);
		await sheet(page).getByRole('button', { name: words.closeSheet, exact: true }).click();
		await expect(sheet(page)).toBeHidden();
		await expect(trigger(page)).toBeFocused();
		await page.goForward();
		await expect(field).toBeFocused();
		const row = new RegExp(`^${literal(`${words.kind.route} ${line.short} · ${line.long}`)}`);
		await sheet(page).getByRole('option', { name: row }).click();
		await expect(page).toHaveURL(
			(url) => url.pathname === localizeHref(`/lines/${line.id}`, locale),
		);
		await page.goBack();
		await expect(page).toHaveURL((url) => url.pathname === home);
		await expect(sheet(page)).toBeHidden();
		expect(await entries()).toBe(length);
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
		await expect(page.locator('[data-slot="app-shell-row"]')).not.toHaveAttribute('inert');
		await expect(page.getByRole('combobox', { name })).toBeVisible();
	});
}
