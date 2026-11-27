import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

import { navPillCopy } from '../src/lib/i18n/messages';
import { headerSearchCopy } from '../src/lib/components/shell/headerSearch.copy';
import { SURFACE_NAV } from '../src/lib/content/nav';
import { copy as searchCopy } from '../src/lib/features/search/search.copy';
import { PUBLISHED_LOCALES } from '../src/lib/i18n/config';
import { localizeHref } from '../src/lib/i18n/routing';

const fixture = (name: string) =>
	JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'));
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stop = fixture('stops-index.json').stops[0];
const line = fixture('routes-index.json').routes[0];
const stops = SURFACE_NAV.find((item) => item.key === 'stops')!.href;
const map = SURFACE_NAV.find((item) => item.key === 'map')!.href;
const address = {
	lat: stop.lat,
	lon: stop.lon,
	label: 'Fixture address',
	source: 'geo_ca',
	precision: 'address',
};

test.use({ bypassCSP: true });

test.beforeEach(async ({ page }) => {
	await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
	await page.route('**/api/geocode**', (route) => route.fulfill({ json: { results: [address] } }));
});

for (const locale of PUBLISHED_LOCALES) {
	const nav = navPillCopy[locale];

	test(`${locale}: keyboard search opens a line, stop and vehicle, with one Back`, async ({
		page,
	}) => {
		const start = localizeHref(stops, locale, 'stm');
		await page.goto(start);
		await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
		const heading = page.getByRole('heading', { level: 1 });
		const startTitle = await heading.innerText();
		for (const [query, target] of [
			[line.long, `/lines/${line.id}`],
			[stop.name, `/stop/${stop.id}`],
			['40061', '/vehicle/40061'],
		] as const) {
			const trigger = page.getByRole('button', { name: nav.searchAria.all, exact: true });
			const field = page.getByRole('combobox', { name: nav.searchAria.all });
			const compact = await trigger.isVisible();
			const control = compact ? trigger : field;
			for (
				let i = 0;
				i < 20 && !(await control.evaluate((el) => el === document.activeElement));
				i++
			)
				await page.keyboard.press('Tab');
			await expect(control).toBeFocused();
			if (compact) await page.keyboard.press('Enter');
			await expect(field).toBeFocused();
			await page.keyboard.type(query);
			const result = page
				.getByRole('option')
				.filter({
					hasText: query,
				})
				.first();
			await expect(result).toHaveAttribute('aria-selected', 'true');
			await page.keyboard.press('ArrowUp');
			await expect(result).toHaveAttribute('aria-selected', 'false');
			await page.keyboard.press('ArrowDown');
			await expect(result).toHaveAttribute('aria-selected', 'true');
			await page.keyboard.press('Enter');
			await expect(page).toHaveURL((url) => url.pathname === localizeHref(target, locale));
			await page.goBack();
			await expect(page).toHaveURL((url) => url.pathname + url.search === start);
			await expect(heading).toHaveText(startTitle);
		}
	});

	test(`${locale}: loads one city index for suggestions and short queries`, async ({ page }) => {
		let requests = 0;
		await page.route('**/api/search-index?*', (route) => {
			requests++;
			return route.continue();
		});
		await page.goto(localizeHref('/search', locale));
		const main = page.getByRole('main');
		await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
		await expect(main.getByText(searchCopy[locale].trySearch)).toBeVisible();
		await expect(main.getByRole('link', { name: /^\d+$/ }).first()).toBeVisible();
		await main.getByRole('textbox', { name: searchCopy[locale].inputLabel }).fill('x');
		await expect(main.getByText(headerSearchCopy[locale].short)).toBeVisible();
		expect(requests).toBe(1);
	});

	test(`${locale}: the header search finds a stop and Enter opens it`, async ({ page }, {
		project,
	}) => {
		test.skip(project.name !== 'desktop', 'the header search box shows from 1280px');
		await page.goto(localizeHref(stops, locale));
		const box = page.getByRole('combobox', { name: nav.searchAria.all });
		const result = page.getByRole('listbox', { name: nav.searchAria.all }).getByRole('option', {
			name: new RegExp(`^${literal(`${headerSearchCopy[locale].kind.stop} ${stop.name}`)}`),
		});
		// Hydration can reset the box; retry until the results answer.
		await expect(async () => {
			await box.fill(stop.name);
			await expect(result).toBeVisible({ timeout: 1_000 });
		}).toPass();
		await box.press('Enter');
		await expect(page).toHaveURL(
			(url) => url.pathname === localizeHref(`/stop/${stop.id}`, locale),
		);
	});

	test(`${locale}: the header search hands an address to the map`, async ({ page }, {
		project,
	}) => {
		test.skip(project.name !== 'desktop', 'the header search box shows from 1280px');
		await page.goto(localizeHref('/', locale));
		const box = page.getByRole('combobox', { name: nav.searchAria.all });
		const list = page.getByRole('listbox', { name: nav.searchAria.all });
		const words = headerSearchCopy[locale];
		const ask = list.getByRole('option', { name: words.askAddresses(address.label) });
		await expect(async () => {
			await box.fill(address.label);
			await expect(ask).toBeVisible({ timeout: 1_000 });
		}).toPass();
		// Nothing is sent while typing; the address row asks.
		await ask.click();
		await list.getByRole('option', { name: `${words.kind.address} ${address.label}` }).click();
		await expect(page).toHaveURL(
			(url) =>
				url.pathname === localizeHref(map, locale) &&
				url.searchParams.get('nearLabel') === address.label,
		);
		// The map takes the address as its near-me origin and lists the stop beside it.
		const nearby = page.locator('[data-slot="map-nearby-stops"]');
		await expect(nearby.getByRole('heading')).toContainText(address.label);
		await expect(nearby.getByRole('link', { name: stop.name, exact: true })).toBeVisible();
	});

	// Fills the header field until hydration keeps the value and the row answers.
	async function headerRow(page: Page, query: string, row: string) {
		const result = page
			.getByRole('listbox', { name: nav.searchAria.all })
			.getByRole('option', { name: new RegExp(`^${literal(row)}`) });
		await expect(async () => {
			await page.getByRole('combobox', { name: nav.searchAria.all }).fill(query);
			await expect(result).toBeVisible({ timeout: 1_000 });
		}).toPass();
		return result;
	}
	const lineRow = (entry: typeof line) =>
		`${headerSearchCopy[locale].kind.route} ${entry.short} · ${entry.long}`;

	test(`${locale}: the header search opens a line page from the home page`, async ({ page }, {
		project,
	}) => {
		test.skip(project.name !== 'desktop', 'the header search box shows from 1280px');
		await page.goto(localizeHref('/', locale));
		await (await headerRow(page, line.long, lineRow(line))).click();
		await expect(page).toHaveURL(
			(url) => url.pathname === localizeHref(`/lines/${line.id}`, locale),
		);
	});

	test(`${locale}: on the map selecting a line keeps focus in the header search`, async ({ page }, {
		project,
	}) => {
		test.skip(project.name !== 'desktop', 'the header search box shows from 1280px');
		await page.goto(localizeHref(map, locale));
		await (await headerRow(page, line.long, lineRow(line))).click();
		await expect(page).toHaveURL(
			(url) =>
				url.pathname === localizeHref(map, locale) && url.searchParams.get('line') === line.id,
		);
		await expect(page.locator('[data-slot="nav-search"]').getByRole('combobox')).toBeFocused();
	});

	test(`${locale}: from a Line Record another line opens for the same dates`, async ({ page }, {
		project,
	}) => {
		test.skip(project.name !== 'desktop', 'the header search box shows from 1280px');
		const other = fixture('routes-index.json').routes[1];
		await page.goto(
			localizeHref(`/lines/${line.id}?recordFrom=2026-11-08&recordTo=2026-11-14`, locale),
		);
		const row = await headerRow(page, other.short, lineRow(other));
		await row.click();
		await expect(page).toHaveURL(
			(url) =>
				url.pathname === localizeHref(`/lines/${other.id}`, locale) &&
				!url.searchParams.has('tab') &&
				url.searchParams.get('recordFrom') === '2026-11-08' &&
				url.searchParams.get('recordTo') === '2026-11-14',
		);
		const record = page.getByRole('radio', {
			name: locale === 'fr' ? 'Bilan' : 'Record',
			exact: true,
		});
		await expect(record).toBeChecked();
		await expect(page.locator('#punctuality')).toBeVisible();
		// One Back shows the line the search began on: the page itself, not only its URL.
		await page.goBack();
		await expect(page.getByRole('heading', { level: 1 })).toHaveText(
			`${locale === 'fr' ? 'Ligne' : 'Line'} ${line.short} ${line.long}`,
		);
	});

	test(`${locale}: the header opens all results or a scoped search page, and Back returns`, async ({
		page,
	}, { project }) => {
		test.skip(project.name !== 'desktop', 'the header search box shows from 1280px');
		const words = searchCopy[locale];
		const field = page.getByRole('main').getByRole('textbox', { name: words.inputLabel });
		const stopsTab = page.getByRole('tab', { name: new RegExp(`^${literal(words.stopsLabel)}`) });
		const allTab = page.getByRole('tab', { name: words.scopeAll, exact: true });
		const start = localizeHref(stops, locale);
		await page.goto(start);
		await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');

		// A partial name has no exact first row, so Enter opens /search with it.
		const partial = stop.name.slice(0, -2);
		const box = page.getByRole('combobox', { name: nav.searchAria.all });
		await box.fill(partial);
		await expect(page.getByRole('listbox', { name: nav.searchAria.all })).toBeVisible();
		await box.press('Enter');
		await expect(page).toHaveURL(
			(url) =>
				url.pathname === localizeHref('/search', locale) &&
				url.searchParams.get('q') === partial &&
				!url.searchParams.has('kind'),
		);
		await expect(field).toHaveValue(partial);
		await expect(allTab).toHaveAttribute('aria-selected', 'true');

		await page.goBack();
		await expect(page).toHaveURL((url) => url.pathname + url.search === start);

		const more = page.getByRole('listbox', { name: nav.searchAria.all }).locator('[id$="-all"]');
		await box.fill(stop.name);
		await expect(more).toHaveAttribute('href', expect.stringContaining('kind=stop'));
		await more.click();
		await expect(page).toHaveURL(
			(url) =>
				url.pathname === localizeHref('/search', locale) &&
				url.searchParams.get('q') === stop.name &&
				url.searchParams.get('kind') === 'stop',
		);
		await expect(field).toHaveValue(stop.name);
		await expect(stopsTab).toHaveAttribute('aria-selected', 'true');
	});

	test(`${locale}: the search page finds lines, stops and vehicles from the search index`, async ({
		page,
	}) => {
		for (const [query, name, path] of [
			[line.long, line.long, `/lines/${line.id}`],
			[stop.name, stop.name, `/stop/${stop.id}`],
			['98765', 'Crémazie Clean', '/stop/clean-search-stop'],
			['cremazie clean', 'Crémazie Clean', '/stop/clean-search-stop'],
			['40061', '40061', '/vehicle/40061'],
		]) {
			await page.goto(localizeHref(`/search?q=${encodeURIComponent(query)}`, locale));
			await expect(
				page
					.getByRole('main')
					.getByRole('link', {
						name: new RegExp(literal(name)),
					})
					.first(),
			).toHaveAttribute('href', new RegExp(`^${literal(localizeHref(path, locale))}(\\?|$)`));
		}
	});

	test(`${locale}: line names follow the selected city's declaration in search`, async ({
		page,
	}) => {
		const query = encodeURIComponent(locale === 'en' ? 'Hôpital' : 'Hospital');
		for (const [city, label] of [
			['octranspo', locale === 'en' ? 'Waller / Hospital' : 'Waller / Hôpital'],
			['stm', 'Waller <> Hospital ~ Hôpital'],
		]) {
			await page.goto(localizeHref(`/search?q=${query}&provider=${city}`, locale));
			await expect(
				page.getByRole('main').getByRole('link', { name: new RegExp(literal(label)) }),
			).toBeVisible();
		}
	});
}
