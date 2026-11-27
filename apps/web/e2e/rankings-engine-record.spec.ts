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
						if (kind === 'vehicle')
							await expect(table).toContainText(
								fr ? '5 interruptions en 21 heures' : '5 times in 21 hours',
							);
						if (kind === 'line') {
							await expect(table.getByRole('rowheader')).toContainText(
								fr ? 'East B9 à West B9' : 'East B9 to West B9',
							);
							await expect(table.getByRole('rowheader')).toContainText(
								fr ? 'Faible couverture' : 'Low coverage',
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
							await expect(table).toContainText(fr ? /par heure/iu : /an hour/u);
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
					await main.getByRole('button', { name: fr ? 'Télécharger' : 'Download' }).click();
					const csv = await page.getByRole('dialog').getByRole('link').first().getAttribute('href');
					const response = await request.get(csv!);
					expect(await response.text()).toMatch(fr ? /^Rang,Type,Identifiant/ : /^Rank,Kind,ID/);
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

test('keeps one history entry per rank and measure choice', async ({ page }) => {
	await page.goto(`/rankings?provider=stm&${dates}`);
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
	const main = page.getByRole('main');
	await main.getByRole('radio', { name: 'Stops', exact: true }).click();
	await expect(page).toHaveURL(/kind=stop/u);
	await main.getByRole('radio', { name: 'Late share', exact: true }).click();
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

test('uses segmented measures and explains an available choice of line classes', async ({
	page,
}) => {
	await page.goto(`/rankings?provider=stm&${dates}`);
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
	const main = page.getByRole('main');
	await expect(
		main.getByRole('radiogroup', { name: 'By', exact: true }).getByRole('radio'),
	).toHaveCount(7);
	await expect(main.getByRole('combobox')).toHaveCount(0);
	const classes = main.getByRole('radiogroup', { name: 'Compare lines' });
	// An address without a class ranks every line, and the highlight says so.
	await expect(classes.getByRole('radio', { name: 'All lines' })).toBeChecked();
	await expect(main.getByText('Includes every service class.')).toBeVisible();
	const frequent = classes.getByRole('radio', { name: 'Frequent lines' });
	await frequent.focus();
	await frequent.press('Enter');
	await expect(page).toHaveURL(/class=3%3Afrequent/u);
	await expect(frequent).toBeChecked();
	await expect(frequent).toBeFocused();
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
		const main = page.getByRole('main');
		const picker = main.getByRole('button', { name: new RegExp(`^${compare} `, 'u') });
		await expect(picker).toContainText(all);
		await picker.click();
		const classes = main.getByRole('list', { name: compare, exact: true });
		await expect(classes.getByRole('button', { name: all, exact: true })).toHaveAttribute(
			'aria-pressed',
			'true',
		);
		await classes.getByRole('button', { name: frequent, exact: true }).click();
		await expect(page).toHaveURL(/class=3%3Afrequent/u);
		await expect(picker).toContainText(frequent);
		await expect(picker).toHaveAttribute('aria-expanded', 'false');
		await expect(main.getByRole('combobox')).toHaveCount(0);

		const measure = main.getByRole('button', { name: new RegExp(`^${by} `, 'u') });
		await measure.press('Enter');
		const choices = main.getByRole('list', { name: by, exact: true });
		await expect(choices.getByRole('button')).toHaveCount(7);
		await choices.getByRole('button', { name: late, exact: true }).click();
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
	await expect(page.getByText('These records take longer')).toBeVisible();
	const port = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';
	const release = await request.post(
		`http://127.0.0.1:${port}/__overview/release?fixture=rankings`,
	);
	expect(release.status()).toBe(204);
	await expect(page.locator('[data-slot="range-mark"]')).toBeVisible();
});

test('the rank and measure controls reflow at 200% text', async ({ page }) => {
	await page.goto(`/fr/rankings?provider=stm&${dates}`);
	await page.addStyleTag({ content: 'html {font-size:200%}' });
	const main = page.getByRole('main');
	await expect(main.locator('[data-slot="range-mark"]')).toBeVisible();
	for (const width of [320, 390, 768, 1024, 1440]) {
		await page.setViewportSize({ width, height: 900 });
		expect(await main.evaluate((node) => node.scrollWidth)).toBeLessThanOrEqual(width);
		expect(await textDefects(page)).toEqual([]);
	}
});
