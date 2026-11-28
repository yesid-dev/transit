import { csvText } from '../src/tests/csv';
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { join } from 'node:path';
import { textDefects } from './layout-helpers';

const dates = 'recordFrom=2026-10-27&recordTo=2026-11-02';
const examples = [
	['line', '', 'Worst lines', 'Pires lignes', 'Lines', 'Lignes'],
	['stop', '&measure=late', 'Worst stops', 'Pires arrêts', 'Stops', 'Arrêts'],
	[
		'departure',
		'',
		'Departures that fail most often',
		'Départs les moins fiables',
		'Departures',
		'Départs',
	],
	[
		'vehicle',
		'',
		'Vehicles that stop reporting most often',
		'Véhicules qui cessent le plus souvent de se signaler',
		'Vehicles',
		'Véhicules',
	],
] as const;

test.use({ bypassCSP: true });
test.beforeEach(({ browserName }, info) =>
	test.skip(browserName !== 'chromium' || info.project.name !== 'desktop'),
);

for (const provider of ['stm', 'octranspo'] as const) {
	for (const locale of ['en', 'fr'] as const) {
		const fr = locale === 'fr';
		const prefix = fr ? '/fr' : '';
		for (const [kind, extras, en, french, enList, frList] of examples) {
			test(`${provider} ${locale} ${kind} uses the canonical rankings screen`, async ({
				page,
				request,
			}) => {
				const main = page.getByRole('main');
				const unsupported = provider === 'octranspo' && kind === 'vehicle';
				const heights: Record<number, number> = {};
				await page.goto(`${prefix}/rankings?provider=${provider}&kind=${kind}&${dates}${extras}`);
				for (const width of [1440, 390]) {
					const theme = fr || (width === 390 && provider === 'stm') ? 'dark' : 'light';
					await page.setViewportSize({ width, height: 900 });
					await page.emulateMedia({ colorScheme: theme });
					await page.evaluate((theme) => localStorage.setItem('theme', theme), theme);
					await page.reload();
					await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
					await expect(main.getByRole('heading', { level: 1 })).toHaveAccessibleName(
						fr ? french : en,
					);
					if (unsupported) {
						await expect(main.locator('[data-record-state="not_tracked"]')).toBeVisible();
						await expect(main.getByRole('table')).toHaveCount(0);
					} else {
						const table = main.getByRole('table', { name: fr ? frList : enList, exact: true });
						await expect(
							main.getByText(fr ? 'Vous avez vu une erreur\u00a0?' : 'Seen an error?', {
								exact: true,
							}),
						).toBeVisible();
						await expect(
							main.getByRole('link', {
								name: fr ? 'À propos de Transit' : 'About Transit',
								exact: true,
							}),
						).toHaveAttribute('href', /\/metrics.*#about-transit$/u);
						await expect(table.locator('tbody tr')).toHaveCount(1);
						await expect(table.getByRole('link')).toHaveCount(1);
						const lead = main
							.locator('[data-slot="screen-answer"] p')
							.filter({ has: page.getByRole('link') });
						await expect(lead).toHaveCount(1);
						await expect(lead.getByRole('link')).toHaveAttribute(
							'href',
							(await table.getByRole('link').getAttribute('href')) ?? '',
						);
						// A vehicle's 24.4 interruptions per 100 hours read per hour: 0.2.
						await expect(table).toContainText(kind === 'vehicle' ? /0[,.]2/u : /48[,.]0\s*%/u);
						if (kind === 'vehicle') {
							await expect(table).toContainText(
								fr ? '5 interruptions en 20,5 heures' : '5 times in 20.5 hours',
							);
							// 0.1 silent hours over 5 interruptions: 72 s each on average.
							await expect(table).toContainText(
								fr ? /d’une durée moyenne de 72\s?s/u : /lasting 72\s?s on average/u,
							);
						}
						if (kind === 'line') {
							if (width === 1440) {
								await expect(table.getByRole('rowheader')).toContainText(
									fr ? 'East B9 à West B9' : 'East B9 to West B9',
								);
								await expect(table.getByRole('rowheader')).toContainText(
									fr ? 'Faible couverture' : 'Low coverage',
								);
							} else {
								await expect(table.getByRole('rowheader')).not.toContainText(
									fr ? 'Faible couverture' : 'Low coverage',
								);
							}
							// The on-time list says which way each line misses: 4 early, 48 late of 100.
							const way = fr
								? /en avance 4,0\s?%, en retard 48,0\s?%/iu
								: /early 4\.0%, late 48\.0%/iu;
							await expect(table.getByRole('rowheader')).toContainText(way);
							// The headline keeps a space between the name and the parenthesis.
							await expect(lead).toContainText(
								fr
									? /\S \(en avance 4,0\s?%, en retard 48,0\s?%\)\.$/u
									: /\S \(early 4\.0%, late 48\.0%\)\.$/u,
							);
							// On a phone the counts join the row's one muted sentence.
							await expect(
								width === 1440
									? table.getByRole('cell', { name: fr ? /12 trajets/u : /12 trips/u })
									: table.getByRole('rowheader').getByText(fr ? /12 trajets/u : /12 trips/u),
							).toBeVisible();
						}
						if (kind === 'departure') {
							await expect(table.getByRole('link')).toHaveAttribute('href', /\/departure\//u);
							if (provider === 'stm')
								await expect(table.getByRole('link')).toContainText(
									fr ? 'vers West B9' : 'toward West B9',
								);
						}
						if (kind === 'stop' && provider === 'stm')
							await expect(table.getByRole('link')).toContainText('Fixture stop');
						if (kind === 'vehicle') {
							await expect(
								main.getByText(
									fr
										? 'Aucune plage n’est disponible pour ces rangs.'
										: 'No range is available for these ranks.',
									{ exact: true },
								),
							).toHaveCount(1);
							await expect(
								table.getByRole('columnheader', { name: fr ? /^Plage/u : /^Range/u }),
							).toHaveCount(0);
							// Read per hour, not per 100 hours, in the header or the phone row.
							const perHour = width === 390 ? /\/\s*h/u : fr ? /par heure/iu : /an hour/u;
							await expect(table).toContainText(perHour);
							await expect(table).not.toContainText(fr ? 'par 100 h' : 'per 100 h');
						} else {
							await expect(
								table.getByText(fr ? 'Moins bien que le réseau' : 'Worse than the network'),
							).toBeVisible();
							if (width === 1440)
								await expect(
									table.getByRole('columnheader', {
										name: fr ? /^Plage, réseau/u : /^Range, against the network/u,
									}),
								).toBeVisible();
						}
					}
					expect(await main.evaluate((node) => node.scrollWidth)).toBeLessThanOrEqual(width);
					const axe = await new AxeBuilder({ page })
						.include('main')
						.withTags(['wcag2a', 'wcag2aa'])
						.analyze();
					expect(axe.violations).toEqual([]);
					heights[width] = await page.evaluate(() => document.documentElement.scrollHeight);
					const art = process.env.TRANSIT_RANKINGS_ARTWORK;
					if (art)
						await page.screenshot({
							path: join(art, `${kind}-${provider}-${locale}-${width}-${theme}.png`),
							fullPage: true,
						});
				}
				await test.info().attach('rankings-heights', {
					body: JSON.stringify({ kind, provider, locale, heights }),
					contentType: 'application/json',
				});
				if (!unsupported && kind === 'line') {
					// Before hydration, Download leads to the Download page; the window opens once hydrated.
					await expect(page.locator('html[data-hydrated]')).toBeAttached();
					await main.getByRole('button', { name: fr ? 'Télécharger' : 'Download' }).click();
					const csv = await page.getByRole('dialog').getByRole('link').first().getAttribute('href');
					const response = await request.get(csv!);
					expect(csvText(await response.body())).toMatch(
						fr ? /^Rang,Type,Identifiant/u : /^Rank,Kind,ID/u,
					);
				}
			});
		}
	}
}

test('redirects legacy rankings permanently with their choices and dates', async ({ request }) => {
	for (const [from, expected] of [
		['/hotspots', '/rankings'],
		['/fr/repeat-offenders', '/fr/rankings?kind=departure'],
		[
			`/fr/hotspots?kind=stops&measure=late&provider=stm&${dates}`,
			`/fr/rankings?provider=stm&${dates}&kind=stop&measure=late`,
		],
		['/repeat-offenders?kind=buses&measure=unknown', '/rankings?kind=vehicle'],
	]) {
		const response = await request.get(from, { maxRedirects: 0 });
		expect(response.status(), from).toBe(301);
		expect(response.headers().location).toBe(expected);
	}
});

test('shows separate exclusions and honest empty and unavailable states', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(
		'/rankings?kind=departure&provider=stm&recordFrom=2026-11-08&recordTo=2026-11-08',
	);
	// The ranking is drawn on the server; its controls answer once the page has hydrated.
	await expect(page.locator('html[data-hydrated]')).toBeAttached();
	const main = page.getByRole('main');
	await expect(main.locator('[data-slot="screen-answer"]')).toContainText(
		'No entries can be ranked on these dates.',
	);
	const excluded = main.getByRole('button', { name: /Excluded, with the reason/u });
	await expect(excluded).toContainText('Too few to judge');
	await excluded.click();
	await expect(main.getByRole('table', { name: 'Excluded, with the reason' })).toBeVisible();
	const art = process.env.TRANSIT_RANKINGS_ARTWORK;
	if (art)
		await page.screenshot({
			path: join(art, 'departures-stm-en-1440-light-excluded.png'),
			fullPage: true,
		});
	await page.goto('/rankings?provider=stm&recordFrom=2026-10-29&recordTo=2026-11-04');
	await expect(main.locator('[data-slot="screen-answer"]')).toContainText(
		'The record is temporarily unavailable.',
	);
	await expect(main.getByRole('table')).toHaveCount(0);
	if (art)
		await page.screenshot({
			path: join(art, 'lines-stm-en-1440-light-unavailable.png'),
			fullPage: true,
		});
});

async function pick(page: import('@playwright/test').Page, label: string, option: string) {
	await page.getByRole('combobox', { name: label, exact: true }).click();
	await page.getByRole('option', { name: option, exact: true }).click();
}

test('keeps one history entry per rank and measure choice', async ({ page }) => {
	await page.goto(`/rankings?provider=stm&${dates}`);
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
	await pick(page, 'Rank', 'Stops');
	await expect(page).toHaveURL(/kind=stop/u);
	await pick(page, 'By', 'Late share');
	await expect(page).toHaveURL(/kind=stop.*measure=late/u);
	await page.goBack();
	await expect(page).toHaveURL(
		(url) => url.searchParams.get('kind') === 'stop' && !url.searchParams.has('measure'),
	);
	await page.goBack();
	await expect(page).toHaveURL(
		(url) => url.pathname === '/rankings' && !url.searchParams.has('kind'),
	);
});

test('uses the desktop rail to select a line class and explains it', async ({ page }) => {
	await page.goto(`/rankings?provider=stm&${dates}`);
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
	const main = page.getByRole('main');
	const choices = page.getByRole('group', { name: 'Rank', exact: true });
	await expect(main.getByRole('combobox')).toHaveCount(0);
	const classes = choices.getByRole('combobox', { name: 'Compare lines' });
	await expect(classes).toContainText('All lines');
	await expect(main.getByText('Includes every service class.')).toBeVisible();
	await pick(page, 'Compare lines', 'Frequent lines');
	await expect(page).toHaveURL(/class=3%3Afrequent/u);
	await expect(classes).toContainText('Frequent lines');
	await expect(main.getByText('10 minutes or less.', { exact: false })).toBeVisible();
	// The chosen class is said in the title block and in the answer's count.
	await expect(main.getByText('frequent lines, by on-time share', { exact: false })).toBeVisible();
	await expect(main.locator('[data-slot="screen-answer"]')).toContainText(
		'for 1 frequent line with enough to judge',
	);
	await page.goto('/rankings?provider=stm&recordFrom=2026-11-01&recordTo=2026-11-07');
	await expect(main.getByRole('table', { name: 'Lines' })).toBeVisible();
	await expect(classes).toHaveCount(0);
});

for (const [width, height] of [
	[1440, 900],
	[1366, 768],
	[1280, 720],
] as const) {
	test(
		'Compare lines is reachable by keyboard and pointer at ' + width + 'x' + height,
		async ({ page }, info) => {
			await page.setViewportSize({ width, height });
			const rail = page.getByRole('complementary', { name: 'Controls', exact: true });
			const classes = rail.getByRole('combobox', { name: 'Compare lines', exact: true });
			const scrollTop = () => rail.evaluate((element) => element.scrollTop);
			async function openRankings() {
				await page.goto('/rankings?provider=stm&' + dates);
				await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
				await expect(classes).toContainText('All lines');
			}

			await openRankings();
			const dimensions = await rail.evaluate(({ clientHeight, scrollHeight }) => ({
				clientHeight,
				scrollHeight,
			}));
			const beforeKeyboard = await scrollTop();
			if (width === 1366) {
				for (const label of ['Rank', 'By', 'Compare lines']) {
					await expect(rail.getByRole('combobox', { name: label, exact: true })).toBeInViewport({
						ratio: 0.95,
					});
				}
				const art = process.env.TRANSIT_RANKINGS_ARTWORK;
				if (art) await page.screenshot({ path: join(art, 'rankings-rail-1366x768.png') });
			}
			await rail.getByRole('combobox', { name: 'By', exact: true }).focus();
			for (
				let step = 0;
				step < 4 && !(await classes.evaluate((el) => el === document.activeElement));
				step++
			) {
				await page.keyboard.press('Tab');
			}
			await expect(classes).toBeFocused();
			await expect(classes).toBeInViewport({ ratio: 0.95 });
			const afterKeyboard = await scrollTop();
			await page.keyboard.press('Enter');
			await expect(page.getByRole('option', { name: 'Frequent lines', exact: true })).toBeVisible();

			await openRankings();
			const beforePointer = await scrollTop();
			await rail.hover();
			await page.mouse.wheel(0, 700);
			await expect(classes).toBeInViewport({ ratio: 0.95 });
			const afterPointer = await scrollTop();
			await pick(page, 'Compare lines', 'Frequent lines');
			await expect(page).toHaveURL(/class=3%3Afrequent/u);

			await info.attach('rankings-rail-scroll', {
				body: JSON.stringify({
					width,
					height,
					...dimensions,
					beforeKeyboard,
					afterKeyboard,
					beforePointer,
					afterPointer,
				}),
				contentType: 'application/json',
			});
		},
	);
}

test('ranked line names have room beside the values at 1024px', async ({ page }) => {
	await page.setViewportSize({ width: 1024, height: 900 });
	await page.goto(`/fr/rankings?provider=stm&${dates}`);
	const name = page.locator('#ranking tbody .phone-text').first();
	await expect(name).toBeVisible();
	expect((await name.boundingBox())?.width).toBeGreaterThanOrEqual(140);
});

for (const [prefix, by, compare, all, frequent, late] of [
	['', 'By', 'Compare lines', 'All lines', 'Frequent lines', 'Late share'],
	['/fr', 'Par', 'Comparer les lignes', 'Toutes les lignes', 'Lignes fréquentes', 'Part en retard'],
] as const) {
	test(`phone ranking choices open from the selected value (${prefix || 'en'})`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto(`${prefix}/rankings?provider=stm&${dates}`);
		await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
		const controls = page.getByRole('button', { name: /Open controls|Ouvrir les options/u });
		await controls.click();
		const sheet = page.getByRole('dialog');
		const picker = sheet.getByRole('combobox', { name: compare, exact: true });
		await expect(picker).toContainText(all);
		await picker.click();
		const classes = page.getByRole('listbox', { name: compare, exact: true });
		await expect(classes.getByRole('option', { name: all, exact: true })).toHaveAttribute(
			'aria-selected',
			'true',
		);
		await classes.getByRole('option', { name: frequent, exact: true }).click();
		await expect(page).toHaveURL(/class=3%3Afrequent/u);
		await expect(picker).toContainText(frequent);
		await expect(picker).toHaveAttribute('aria-expanded', 'false');
		await expect(page.getByRole('main').getByRole('combobox')).toHaveCount(0);

		const measure = sheet.getByRole('combobox', { name: by, exact: true });
		await measure.press('Enter');
		const choices = page.getByRole('listbox', { name: by, exact: true });
		await expect(choices.getByRole('option')).toHaveCount(7);
		await measure.press('Escape');
		await expect(choices).toBeHidden();
		await expect(measure).toBeFocused();
		await measure.press('Enter');
		await choices.getByRole('option', { name: late, exact: true }).click();
		await expect(page).toHaveURL(/measure=late/u);
		await expect(measure).toContainText(late);
	});
}

test('pages in groups of twenty and withholds a mismatched reference', async ({ page }) => {
	await page.goto('/rankings?provider=stm&recordFrom=2026-10-28&recordTo=2026-11-03');
	const main = page.getByRole('main');
	const rows = main.getByRole('table', { name: 'Lines', exact: true }).locator('tbody tr');
	await expect(rows).toHaveCount(20);
	await expect(
		main.getByText('A comparable reference is unavailable for these dates.'),
	).toBeVisible();
	await expect(main.locator('[data-slot="range-mark"] [aria-describedby]')).toHaveCount(0);
	await main.getByRole('button', { name: 'Show 1 more', exact: true }).click();
	await expect(rows).toHaveCount(21);
});

test('the ranking streams before its readings complete', async ({ page, request }) => {
	const response = await page.goto(
		'/rankings?provider=stm&recordFrom=2026-11-09&recordTo=2026-11-14',
		{ waitUntil: 'commit' },
	);
	expect(response?.headers()['cache-control']).toBe('no-store, no-transform');
	await expect(page.getByRole('heading', { name: 'Worst lines', exact: true })).toBeVisible();
	await expect(page.getByText('Still calculating the record')).toBeVisible();
	const cards = page.getByRole('main').locator('[data-slot="card"]');
	await expect(cards).toHaveCount(3);
	await expect(cards.locator('[data-waiting-shape="rows"]')).toBeVisible();
	const port = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';
	const release = await request.post(
		`http://127.0.0.1:${port}/__overview/release?fixture=rankings`,
	);
	expect(release.status()).toBe(204);
	await expect(page.locator('[data-slot="range-mark"]')).toBeVisible();
});

test('the rank and measure controls reflow at 200% text', async ({ page }) => {
	await page.goto(`/fr/rankings?provider=stm&${dates}`);
	await expect(page.locator('html[data-hydrated]')).toBeAttached();
	await page.addStyleTag({ content: 'html {font-size:200%}' });
	const main = page.getByRole('main');
	await expect(main.locator('[data-slot="range-mark"]')).toBeVisible();
	for (const width of [320, 390, 768, 1024, 1440]) {
		await page.setViewportSize({ width, height: 900 });
		expect(await main.evaluate((node) => node.scrollWidth)).toBeLessThanOrEqual(width);
		expect(await textDefects(page)).toEqual([]);
	}
});
