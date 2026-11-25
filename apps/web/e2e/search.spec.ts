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
	for (const provider of ['stm', 'octranspo']) {
		test(`${locale}/${provider}: Live home invitation opens the existing search page`, async ({
			page,
		}) => {
			await page.goto(localizeHref(`/?provider=${provider}&frameMode=live`, locale));
			await page
				.locator('[data-slot="home-search"]')
				.getByRole('link', {
					name:
						locale === 'en'
							? 'Search for your line or stop'
							: 'Cherchez votre ligne ou votre arrêt',
				})
				.click();
			await expect(page).toHaveURL((url) => url.pathname === localizeHref('/search', locale));
			await expect(
				page.getByRole('textbox', { name: searchCopy[locale].inputLabel }),
			).toBeVisible();
		});
	}

	test(`${locale}: the header search finds a stop and Enter opens it`, async ({ page }, {
		project,
	}) => {
		test.skip(project.name !== 'desktop', 'the header search box shows from 1024px');
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
		test.skip(project.name !== 'desktop', 'the header search box shows from 1024px');
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
		await expect(page).toHaveURL((url) => url.pathname === localizeHref(map, locale));
		// The map takes the address as its near-me origin and lists the stop beside it.
		await expect(
			page.getByRole('button', { name: new RegExp(`^${literal(stop.name)}`) }),
		).toBeVisible();
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
		test.skip(project.name !== 'desktop', 'the header search box shows from 1024px');
		await page.goto(localizeHref('/', locale));
		await (await headerRow(page, line.long, lineRow(line))).click();
		await expect(page).toHaveURL(
			(url) => url.pathname === localizeHref(`/lines/${line.id}`, locale),
		);
	});

	test(`${locale}: on the map the header search keeps map focus`, async ({ page }, { project }) => {
		test.skip(project.name !== 'desktop', 'the header search box shows from 1024px');
		await page.goto(localizeHref(map, locale));
		await (await headerRow(page, line.long, lineRow(line))).click();
		await expect(page).toHaveURL(
			(url) =>
				url.pathname === localizeHref(map, locale) &&
				url.searchParams.get('focus') === `route:${line.id}`,
		);
	});

	test(`${locale}: from a Line Record another line opens for the same dates`, async ({ page }, {
		project,
	}) => {
		test.skip(project.name !== 'desktop', 'the header search box shows from 1024px');
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
		const record = page
			.getByRole('navigation', { name: /Line views|Vues de la ligne/ })
			.getByRole('link', { name: locale === 'fr' ? 'Bilan' : 'Record' });
		await expect(record).toHaveAttribute('aria-current', 'page');
		await expect(page.locator('#punctuality')).toBeVisible();
		// One Back shows the line the search began on: the page itself, not only its URL.
		await page.goBack();
		await expect(page.getByRole('heading', { level: 1 })).toHaveText(
			`${line.short} · ${line.long}`,
		);
	});

	test(`${locale}: the search page takes the place of a search opened from its header, and back`, async ({
		page,
	}, { project }) => {
		test.skip(project.name !== 'desktop', 'the header search box shows from 1024px');
		const words = searchCopy[locale];
		const field = page.getByRole('main').getByRole('textbox', { name: words.inputLabel });
		const stopsTab = page.getByRole('tab', { name: new RegExp(`^${literal(words.stopsLabel)}`) });
		const allTab = page.getByRole('tab', { name: words.scopeAll, exact: true });
		await page.goto(localizeHref(`/search?q=${encodeURIComponent(stop.name)}&kind=stop`, locale));
		await expect(field).toHaveValue(stop.name);
		await expect(stopsTab).toHaveAttribute('aria-selected', 'true');

		// A partial name has no exact first row, so Enter opens /search with it.
		const partial = stop.name.slice(0, -2);
		const box = page.getByRole('combobox', { name: nav.searchAria.all });
		// Hydration can reset the box; retry until the results answer.
		await expect(async () => {
			await box.fill(partial);
			await expect(page.getByRole('listbox', { name: nav.searchAria.all })).toBeVisible({
				timeout: 1_000,
			});
		}).toPass();
		await box.press('Enter');
		await expect(page).toHaveURL(
			(url) => url.searchParams.get('q') === partial && !url.searchParams.has('kind'),
		);
		await expect(field).toHaveValue(partial);
		await expect(allTab).toHaveAttribute('aria-selected', 'true');

		await page.goBack();
		await expect(page).toHaveURL(
			(url) => url.searchParams.get('q') === stop.name && url.searchParams.get('kind') === 'stop',
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
