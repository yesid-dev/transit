import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

import { navPillCopy } from '../src/lib/i18n/messages';
import { headerSearchCopy } from '../src/lib/components/shell/headerSearch.copy';
import { PUBLISHED_LOCALES } from '../src/lib/i18n/config';
import { localizeHref } from '../src/lib/i18n/routing';

const [line, other] = JSON.parse(
	readFileSync(new URL('./routes-index.json', import.meta.url), 'utf8'),
).routes;
// A line page's heading: what the reader sees, whatever the URL says.
const heading = (entry: typeof line) => `${entry.short} · ${entry.long}`;
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
	// On a line page the field and its button are named for lines.
	const onLine = navPillCopy[locale].searchAria.route;
	const start = localizeHref(`/lines/${other.id}`, locale);
	const row = new RegExp(`^${literal(`${words.kind.route} ${heading(line)}`)}`);
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
		await expect(title).toHaveText(heading(other));
		const length = await entries(page);
		const field = await openSheet(page, onLine);
		// Modal: the header and the page behind the sheet are inert.
		await expect(page.locator('[data-slot="app-shell-row"]')).toHaveAttribute('inert', '');
		await expect(page.locator('[data-slot="app-shell-chrome"]')).toHaveAttribute('inert', '');
		await field.fill(line.long);
		await sheet(page).getByRole('option', { name: row }).click();
		await expect(title).toHaveText(heading(line));
		await expect(sheet(page)).toBeHidden();
		await expect(page.locator('[data-slot="app-shell-row"]')).not.toHaveAttribute('inert');
		expect(await entries(page)).toBe(length + 1);
		// One Back shows the page the search began on, not only its URL.
		await page.goBack();
		await expect(page).toHaveURL((url) => url.pathname === start);
		await expect(title).toHaveText(heading(other));
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

	test(`${locale}: Forward reopens the sheet, Close goes back once, and Enter on a line keeps one Back`, async ({
		page,
	}) => {
		const title = page.getByRole('heading', { level: 1 });
		const field = sheet(page).getByRole('combobox', { name: onLine });
		await page.goto(start);
		await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
		const length = await entries(page);
		await (await openSheet(page, onLine)).fill(line.long);
		await page.goBack();
		await expect(sheet(page)).toBeHidden();
		await page.goForward();
		await expect(field).toBeFocused();
		await expect(field).toHaveValue(line.long);
		await sheet(page).getByRole('button', { name: words.closeSheet, exact: true }).click();
		await expect(sheet(page)).toBeHidden();
		await expect(page.getByRole('button', { name: onLine, exact: true })).toBeFocused();
		await page.goForward();
		await expect(field).toBeFocused();
		// The full name is an exact match, so it is highlighted and Enter opens it.
		await expect(sheet(page).getByRole('option', { name: row })).toHaveAttribute(
			'aria-selected',
			'true',
		);
		await field.press('Enter');
		await expect(title).toHaveText(heading(line));
		expect(await entries(page)).toBe(length + 1);
		await page.goBack();
		await expect(page).toHaveURL((url) => url.pathname === start);
		await expect(title).toHaveText(heading(other));
		await expect(sheet(page)).toBeHidden();
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
