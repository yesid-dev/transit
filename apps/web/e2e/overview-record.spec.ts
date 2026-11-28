import { csvText } from '../src/tests/csv';
import { closeCompactFrameControls, openFrameControls } from './frame-controls';
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
	captureFixture,
	captureFleet,
	captureUrl,
	captureVehicle,
	liveSummaryUrl,
	overviewReadsCapture,
} from './capture-fixture';

test.beforeEach(({ browserName }, info) => {
	test.skip(browserName !== 'chromium' || info.project.name !== 'desktop');
});

const period = 'recordFrom=2026-11-08&recordTo=2026-11-14';
const recordHref = '/?provider=stm&frameMode=record&' + period;

for (const [prefix, controls, open, layout, columns] of [
	['', 'Controls', 'Open controls', 'See the layout and files', 'Parquet columns'],
	[
		'/fr',
		'Options',
		'Ouvrir les options',
		'Voir la structure et les fichiers',
		'Colonnes du fichier Parquet',
	],
] as const) {
	test(`phone figures, controls and download columns stay readable at 200% (${prefix || 'en'})`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto(prefix + recordHref);
		await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
		await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
		const value = page
			.getByRole('article', { name: prefix ? 'Bilan' : 'Record', exact: true })
			.locator('.metric-value')
			.filter({ hasText: /\d[.,]\d\s*%/u });
		await expect(value).toBeVisible();
		await page.evaluate(() => document.fonts.ready);
		const figure = await value.evaluate((element) => {
			const column = element.closest('.answer-value')!.getBoundingClientRect();
			const range = document.createRange();
			range.selectNodeContents(element);
			const { left, right } = range.getBoundingClientRect();
			return {
				lines: range.getClientRects().length,
				fits: left >= column.left - 1 && right <= column.right + 1,
			};
		});
		expect(figure).toEqual({ lines: 1, fits: true });
		const pill = page.getByRole('button', { name: new RegExp(`^${controls}.*${open}`, 'u') });
		await expect(pill).toBeVisible();
		const label = pill.getByText(controls, { exact: true });
		await expect
			.poll(() => label.evaluate((element) => element.scrollWidth - element.clientWidth))
			.toBe(0);
		await pill.click();
		await expect(page.getByRole('dialog', { name: controls, exact: true })).toBeVisible();

		await page.goto(`${prefix}/download?provider=stm&${period}`);
		await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
		const disclosures = page.getByText(layout, { exact: true });
		await expect(disclosures.first()).toBeVisible();
		for (const disclosure of await disclosures.all()) await disclosure.click();
		const column = page
			.getByRole('region', { name: columns, exact: true })
			.getByText('scheduled_departure_seconds', { exact: true })
			.first();
		await expect(column).toBeVisible();
		expect(await column.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
	});
}

test('the desktop French total stays on one line and plate codes keep names aligned', async ({
	page,
}) => {
	const now = Date.now();
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.clock.setFixedTime(now);
	await overviewReadsCapture(page);
	await page.route(captureUrl, (route) =>
		route.fulfill({
			json: captureFixture(now, { vehicle_positions: [captureVehicle(now, { delay: 420 })] }),
		}),
	);
	await page.goto('/fr' + recordHref);
	const total = page
		.getByRole('article', { name: 'Bilan', exact: true })
		.getByText(/^sur 507[ \u00a0\u202f]800 passages aux arrêts$/u);
	await expect(total).toBeVisible();
	await page.evaluate(() => document.fonts.ready);
	expect(
		await total.evaluate((element) => {
			const text = document.createRange();
			text.selectNodeContents(element);
			return text.getClientRects().length;
		}),
	).toBe(1);

	for (const row of [
		page
			.getByRole('article', { name: 'Lignes et arrêts à examiner' })
			.locator('tbody tr')
			.filter({ has: page.locator('[data-slot="route-plate"]') })
			.first(),
		page
			.getByRole('article', { name: 'En direct', exact: true })
			.locator('tbody tr')
			.filter({ has: page.locator('[data-slot="route-plate"]') })
			.first(),
	]) {
		await expect(row).toBeVisible();
		const name = row.getByRole('link').locator('.name-label');
		const left = await name.evaluate((element) => element.getBoundingClientRect().left);
		await row.locator('[data-slot="route-plate"]').evaluate((element) => {
			element.textContent = '165';
		});
		expect(await name.evaluate((element) => element.getBoundingClientRect().left)).toBe(left);
	}
});

test('Live now keeps placeholders until its first fetch fails', async ({ page }) => {
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	await overviewReadsCapture(page);
	await page.route(captureUrl, async (route) => {
		await held;
		await route.fulfill({ status: 503, body: '{}' });
	});
	try {
		const firstCapture = page.waitForRequest(captureUrl);
		await page.goto(recordHref);
		const live = page.getByRole('article', { name: 'Live now' });
		const pending = live.locator('[aria-busy="true"][data-record-pending]');
		await expect(pending.locator('[data-waiting-shape="bands"]')).toBeVisible();
		await expect(pending.locator('[data-waiting-shape="facts"]')).toBeVisible();
		await expect(live).not.toContainText('No live data');
		await firstCapture;
		release();
		await expect(live.getByText('Live numbers unavailable', { exact: true })).toHaveCount(1);
		await expect(live.getByText('Unavailable', { exact: true })).toHaveCount(2);
		await expect(pending).toHaveCount(0);
		await expect(live).not.toContainText('No live data');
	} finally {
		release();
	}
});

test('the server-rendered Live card leaves the readings pending without JavaScript', async ({
	browser,
	baseURL,
}) => {
	const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
	try {
		const page = await context.newPage();
		await page.goto(recordHref);
		await expect(page.getByText(/^STM: \d+ lines, [\d,]+ stops$/u)).toBeVisible();
		const live = page.getByRole('article', { name: 'Live now' });
		const pending = live.locator('[aria-busy="true"][data-record-pending]');
		await expect(pending.locator('[data-waiting-shape="bands"]')).toBeVisible();
		await expect(pending.locator('[data-waiting-shape="facts"]')).toBeVisible();
		await expect(live).not.toContainText('No live data');
	} finally {
		await context.close();
	}
});

test('a retained Live reading says it is stale and agrees with the French singular vehicle label at zero', async ({
	page,
}) => {
	const now = Date.now();
	await page.clock.setFixedTime(now);
	await overviewReadsCapture(page);
	await page.route(captureUrl, (route) => route.fulfill({ json: captureFixture(now - 180_000) }));
	await page.goto('/fr' + recordHref);
	const live = page.getByRole('article', { name: 'En direct' });
	await expect(live.getByText(/mis à jour il y a 3 minutes · pas à jour/u)).toBeVisible();
	await expect(live.getByText('véhicule transmet sa position.')).toBeVisible();
	await expect(live.getByText('Retard inconnu')).toBeVisible();
	await expect(live.getByText('Non mesuré', { exact: true })).toBeVisible();
});

test('a client period change streams the shell before the engine answers', async ({
	page,
	request,
}, info) => {
	// The unscoped comparison uses the same dates the navigation will hold.
	await page.goto('/?provider=stm&frameMode=record&recordFrom=2026-11-17&recordTo=2026-11-23');
	const comparison = page.getByText('Against the 7 days before', { exact: true }).locator('..');
	await expect(comparison.getByText('Not measured', { exact: true })).toBeVisible();
	await page.setExtraHTTPHeaders({ 'x-transit-fixture-scope': 'overview-stream' });
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
	await (await openFrameControls(page)).getByRole('button', { name: 'Choose other dates' }).click();
	const dialog = page.getByRole('dialog', { name: 'Choose dates', exact: true });
	await dialog.getByLabel('From', { exact: true }).fill('2026-11-10');
	await dialog.getByLabel('To', { exact: true }).fill('2026-11-16');
	const dataPort = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';
	const release = `http://127.0.0.1:${dataPort}/__overview/release?fixture=overview-stream`;
	const sent = page.waitForResponse(
		(response) => response.url().includes('/__data.json?') && response.url().includes('2026-11-10'),
	);
	const start = performance.now();
	let shellMs: number;
	let releasedMs: number;
	try {
		await dialog.getByRole('button', { name: 'Show these dates' }).click();
		const response = await sent;
		expect(response.ok()).toBe(true);
		await expect(dialog).toBeHidden();
		await closeCompactFrameControls(page);
		const record = page.getByRole('article', { name: 'Record', exact: true });
		await expect(record.getByText('Record · 10 to 16 Nov 2026').first()).toBeVisible();
		await expect(record.locator('[data-record-pending][aria-busy="true"]').first()).toBeVisible();
		shellMs = performance.now() - start;
		releasedMs = performance.now() - start;
		expect((await request.post(release)).status()).toBe(204);
		await expect(record.getByText('Not measured').first()).toBeVisible();
		const firstByteMs = response.request().timing().responseStart;
		expect(firstByteMs).toBeGreaterThanOrEqual(0);
		expect(firstByteMs).toBeLessThan(releasedMs);
		await info.attach('Overview stream timing', {
			body: JSON.stringify({ firstByteMs, shellMs, releasedMs }),
			contentType: 'application/json',
		});
	} finally {
		await request.post(release);
	}
});

for (const width of [390, 1440]) {
	for (const [provider, city] of [
		['stm', 'Montréal'],
		['octranspo', 'Ottawa'],
	] as const) {
		for (const locale of ['en', 'fr'] as const) {
			const fr = locale === 'fr';
			test(`${provider} ${locale} at ${width}px shows Overview and its evidence`, async ({
				page,
				request,
			}) => {
				await page.setViewportSize({ width, height: 900 });
				await page.goto(`${fr ? '/fr' : '/'}?provider=${provider}&frameMode=record&${period}`);
				await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
				const main = page.getByRole('main');
				const title = fr
					? provider === 'stm'
						? 'Réseau de Montréal'
						: 'Réseau d’Ottawa'
					: `${city} network`;
				const record = main.getByRole('article', { name: fr ? 'Bilan' : 'Record', exact: true });
				const about = main.getByRole('article', {
					name: fr ? 'À propos de ces chiffres' : 'About these figures',
				});
				await expect(main.getByRole('heading', { level: 1 })).toHaveAccessibleName(title);
				await expect(
					record
						.getByText(provider === 'stm' ? /81[,.]2\s?%/ : /70[,.]0\s?%/, { exact: true })
						.first(),
				).toBeVisible();
				await expect(record).toContainText(fr ? /90 sur 100/ : /90 of 100/);
				const deliveryRange = record.getByText(
					fr ? /entre 81,1\s% et 91,0\s%/u : /between 81\.1% and 91\.0% ran/u,
				);
				await expect(deliveryRange).toBeVisible();
				const rangeUsesRowWidth = await deliveryRange.evaluate((note) => {
					const row = note.closest('[data-slot="fact-row"]');
					return (
						row != null &&
						note.getBoundingClientRect().width >= row.getBoundingClientRect().width - 1
					);
				});
				expect(rangeUsesRowWidth).toBe(true);
				await expect(record).toContainText(
					fr ? 'Par rapport aux 7 jours précédents' : 'Against the 7 days before',
				);
				await expect(record.locator('footer')).toContainText(/507[ ,\u00a0\u202f]800/u);
				await expect(about).toContainText(fr ? 'Faible couverture' : 'Low coverage');
				await expect(about).toContainText(
					fr
						? 'La plupart de ces heures proviennent de prévisions.'
						: 'Most times come from predictions.',
				);
				const ranking = main.getByRole('article', {
					name: fr ? 'Lignes et arrêts à examiner' : 'Lines and stops to investigate',
				});
				await expect(ranking.locator('tbody tr')).toHaveCount(6);
				await expect(ranking.getByRole('link')).toHaveCount(7);

				const firstLink = record.getByRole('link').first();
				const copy = record.getByRole('button', { name: fr ? 'Copier le lien' : 'Copy link' });
				const frameEnd = page.getByRole('button', {
					name:
						width === 390
							? fr
								? /^Options.*Ouvrir les options/
								: /^Controls.*Open controls/
							: fr
								? 'Choisir d’autres dates'
								: 'Choose other dates',
				});
				await frameEnd.focus();
				await expect(frameEnd).toBeFocused();
				await page.keyboard.press('Tab');
				await expect(copy).toBeFocused();
				const download = record.getByRole('button', { name: fr ? 'Télécharger' : 'Download' });
				await page.keyboard.press('Tab');
				await expect(download).toBeFocused();
				const cite = record.getByRole('button', { name: fr ? 'Citer' : 'Cite' });
				await page.keyboard.press('Tab');
				await expect(cite).toBeFocused();
				const print = record.getByRole('button', { name: fr ? 'Imprimer' : 'Print' });
				await page.keyboard.press('Tab');
				await expect(print).toBeFocused();
				const trend = record.locator('#overview-record-trend [data-chart-details]');
				await expect(trend).toHaveCount(1);
				await page.keyboard.press('Tab');
				await expect(trend).toBeFocused();
				await page.keyboard.press('ArrowRight');
				await expect(trend).toBeFocused();
				await page.keyboard.press('Tab');
				await expect(firstLink).toBeFocused();
				const trendTable = record.getByRole('button', {
					name: fr ? 'Tableau' : 'Table',
					exact: true,
				});
				await page.keyboard.press('Tab');
				await expect(trendTable).toBeFocused();

				await download.click();
				const exports = page.getByRole('dialog');
				await expect(exports.getByRole('link')).toHaveCount(6);
				const exportHref = await exports.getByRole('link').first().getAttribute('href');
				const csv = await request.get(exportHref!);
				// Each row names its source and licence; the fixture city declares no licence name.
				const agency = provider === 'stm' ? 'STM' : 'OC Transpo';
				const of = provider === 'stm' ? 'de la STM' : 'd’OC Transpo';
				expect(csvText(await csv.body())).toBe(
					fr
						? `measure,from,to,Source des données et licence\npunctuality,2026-11-08,2026-11-14,"Données ouvertes ${of}, calculs de Transit"\n`
						: `measure,from,to,Data source and licence\npunctuality,2026-11-08,2026-11-14,"${agency} open data, computed by Transit"\n`,
				);
				await page.keyboard.press('Escape');
				await expect(download).toBeFocused();
				await cite.click();
				await expect(
					page
						.getByRole('dialog')
						.getByText(/Method v2|Méthode v2/)
						.first(),
				).toBeVisible();
				await page.keyboard.press('Escape');
				await expect(cite).toBeFocused();
				expect(await main.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(width);
			});
		}
	}
}

for (const colorScheme of ['light', 'dark'] as const) {
	for (const provider of ['stm', 'octranspo'] as const) {
		for (const locale of ['en', 'fr'] as const) {
			const fr = locale === 'fr';
			test(`Overview ${provider} ${locale} satisfies WCAG AA in ${colorScheme}`, async ({
				page,
			}) => {
				await page.addInitScript((theme) => localStorage.setItem('theme', theme), colorScheme);
				await page.emulateMedia({ colorScheme });
				await overviewReadsCapture(page);
				await page.route(captureUrl, (route) =>
					route.fulfill({ json: captureFleet(Date.now(), provider, [-120, 0, 360, null]) }),
				);
				for (const [mode, heading] of [
					['record', fr ? 'À propos de ces chiffres' : 'About these figures'],
					['live', fr ? 'À propos des chiffres en direct' : 'About live figures'],
				]) {
					await page.goto(`${fr ? '/fr' : '/'}?provider=${provider}&frameMode=${mode}&${period}`);
					await expect(page.locator('html')).toHaveAttribute('data-theme', colorScheme);
					await expect(page.getByRole('heading', { name: heading })).toBeVisible();
					await expect(page.locator('[data-slot="band-bar"]')).toBeVisible();
					const results = await new AxeBuilder({ page })
						.include('main')
						.withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
						.analyze();
					expect(results.violations, mode).toEqual([]);
				}
			});
		}
	}
}

test('a slow stop ranking shows patience while the other parts remain usable', async ({
	page,
	request,
}) => {
	await page.setExtraHTTPHeaders({ 'x-transit-fixture-scope': 'overview-stop-ranking' });
	await page.goto('/?provider=stm&frameMode=record&recordFrom=2026-11-09&recordTo=2026-11-15', {
		waitUntil: 'commit',
	});
	const main = page.getByRole('main');
	await expect(main.getByText('of observed stop events were on time.')).toBeVisible();
	await expect(main.getByText('Still calculating the record')).toBeVisible();
	await main.getByRole('button', { name: 'Cite' }).click();
	await expect(
		page
			.getByRole('dialog')
			.getByText(/Method v2/)
			.first(),
	).toBeVisible();
	await page.keyboard.press('Escape');
	const dataPort = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';
	const release = await request.post(
		`http://127.0.0.1:${dataPort}/__overview/release?fixture=overview-stop-ranking`,
	);
	expect(release.status()).toBe(204);
	await expect(
		main.getByRole('article', { name: 'Lines and stops to investigate' }).locator('tbody tr'),
	).toHaveCount(6);
	await expect(main.getByText('Still calculating the record')).toHaveCount(0);
});

test('Live and Record show the same punctuality for the same week (OV1)', async ({ page }) => {
	const captures: URL[] = [];
	const snapshots: URL[] = [];
	page.on('request', (request) => {
		const url = new URL(request.url());
		if (captureUrl.test(request.url())) captures.push(url);
		if (/\/(?:v1|v2)\/|hotspots\.json/.test(url.pathname)) snapshots.push(url);
	});
	await overviewReadsCapture(page);
	await page.route(captureUrl, (route) =>
		route.fulfill({ json: captureFleet(Date.now(), 'stm', [-120, 0, 360, null]) }),
	);
	await page.goto(recordHref);
	const main = page.getByRole('main');
	const cards = main.getByRole('article');
	const record = main.getByRole('article', { name: 'Record', exact: true });
	const live = main.getByRole('article', { name: 'Live now', exact: true });
	const reading = record.getByText('81.2%', { exact: true }).first();
	await expect(cards.nth(0)).toHaveAccessibleName('Record');
	await expect(cards.nth(1)).toHaveAccessibleName('Live now');
	await expect(reading).toBeVisible();
	const evidence = record.locator('[data-slot="record-foot-evidence"] > div');
	const bodyFont = await page.locator('html').evaluate((root) => getComputedStyle(root).fontFamily);
	await expect(evidence).toHaveCSS('font-family', bodyFont);
	await expect(evidence).toHaveCSS('font-variant-numeric', 'tabular-nums');
	await expect(live.locator('[data-slot="band-bar"]')).toBeVisible();
	for (const status of ['Early', 'On time', 'Late', 'Delay unknown']) {
		await expect(live.getByRole('term').filter({ hasText: status })).toBeVisible();
	}
	for (const fact of ['Scheduled trips with no vehicle reporting', 'Notice publications']) {
		await expect(
			live
				.locator('[data-slot="fact-row"]')
				.filter({ hasText: fact })
				.locator('[data-slot="separator"]'),
		).toHaveCSS('height', '1px');
	}
	await expect(
		live.getByText('Scheduled trips with no vehicle reporting', { exact: true }).locator('..'),
	).toContainText('Not measured');
	expect(captures.map((url) => url.pathname + url.search)).toEqual(['/api/live?city=stm']);
	expect(snapshots).toEqual([]);

	await (await openFrameControls(page)).getByRole('radio', { name: 'Live now' }).click();
	await closeCompactFrameControls(page);
	await expect(page).toHaveURL(/frameMode=live/);
	await expect(cards.nth(0)).toHaveAccessibleName('Live now');
	await expect(cards.nth(1)).toHaveAccessibleName('Record');
	await expect(reading).toBeVisible();
	await expect(main.getByRole('heading', { name: 'About live figures' })).toBeVisible();
	await expect(main.getByText('Read more', { exact: true })).toHaveCount(0);
	await expect(main.getByText('Search for your line or stop', { exact: true })).toHaveCount(0);
	expect(snapshots).toEqual([]);
});

test('Live now reads the light summary and shows what the full capture shows', async ({ page }) => {
	const liveReads: string[] = [];
	page.on('request', (request) => {
		const url = new URL(request.url());
		if (captureUrl.test(request.url()) || liveSummaryUrl.test(request.url()))
			liveReads.push(url.pathname + url.search);
	});
	const main = page.getByRole('main');
	const live = main.getByRole('article', { name: 'Live now', exact: true });
	const body = live.locator('[data-slot="record-card-body"]');
	const figures = async () => {
		await expect(live.locator('[data-slot="band-bar"]')).toBeVisible();
		await expect(live.locator('[data-record-pending]')).toHaveCount(0);
		return body.innerText();
	};

	const summary = page.waitForResponse((reply) => liveSummaryUrl.test(reply.url()));
	await page.goto(recordHref);
	expect((await summary).ok()).toBe(true);
	const fromSummary = await figures();
	expect(liveReads).toEqual(['/api/live-summary?city=stm']);

	liveReads.length = 0;
	await overviewReadsCapture(page);
	await page.reload();
	expect(await figures()).toBe(fromSummary);
	expect(liveReads).toEqual(['/api/live-summary?city=stm', '/api/live?city=stm']);
});

test('changing the custom period updates the Record card and Back restores the view', async ({
	page,
}) => {
	await page.goto('/?provider=stm&' + period);
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
	const main = page.getByRole('main');
	const record = main.getByRole('article', { name: 'Record', exact: true });
	await expect(record.getByText('Record · 8 to 14 Nov 2026').first()).toBeVisible();
	await (await openFrameControls(page)).getByRole('button', { name: 'Choose other dates' }).click();
	const dialog = page.getByRole('dialog', { name: 'Choose dates', exact: true });
	await dialog.getByLabel('From', { exact: true }).fill('2026-11-08');
	await dialog.getByLabel('To', { exact: true }).fill('2026-11-08');
	await dialog.getByRole('button', { name: 'Show these dates' }).click();
	await expect(dialog).toBeHidden();
	await closeCompactFrameControls(page);
	await expect(record.getByText('Record · 8 Nov 2026').first()).toBeVisible();
	await expect(page).toHaveURL(/recordTo=2026-11-08/);
	await expect(record.getByText('Same weekday last week')).toBeVisible();
	await expect(record.getByText(/78\.8%, 1 Nov 2026/)).toBeVisible();
	await (await openFrameControls(page)).getByRole('radio', { name: 'Live now' }).click();
	await closeCompactFrameControls(page);
	await expect(main.getByRole('article').first()).toHaveAccessibleName('Live now');
	await expect(record.getByText('Record · 8 Nov 2026').first()).toBeVisible();
	await page.goBack();
	await expect(main.getByRole('article').first()).toHaveAccessibleName('Record');
	await expect(record.getByText('Record · 8 Nov 2026').first()).toBeVisible();
});

test('the header carries the Live view and dates through city and language changes', async ({
	page,
}) => {
	await overviewReadsCapture(page);
	await page.route(captureUrl, (route) => {
		const city = new URL(route.request().url()).searchParams.get('city')!;
		return route.fulfill({ json: captureFleet(Date.now(), city, [0, 360]) });
	});
	await page.goto(recordHref.replace('frameMode=record', 'frameMode=live'));
	const main = page.getByRole('main');
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
	await page.locator('[data-slot="site-header-network"] select').selectOption('octranspo');
	const isOttawaLive = (url: URL) =>
		url.searchParams.get('provider') === 'octranspo' &&
		url.searchParams.get('frameMode') === 'live' &&
		url.searchParams.get('recordFrom') === '2026-11-08' &&
		url.searchParams.get('recordTo') === '2026-11-14';
	await expect(page).toHaveURL(isOttawaLive);
	await expect(main.getByRole('heading', { level: 1 })).toHaveAccessibleName('Ottawa network');
	const live = main.getByRole('article', { name: 'Live now', exact: true });
	await expect(
		live.getByText('Scheduled trips with no vehicle reporting', { exact: true }).locator('..'),
	).toContainText('Not measured');
	// A provider with no open feed keeps its agency’s notices link.
	const alerts = live.getByText('Notice publications', { exact: true }).locator('..');
	await expect(alerts).toContainText('Not published');
	await expect(alerts).toContainText(
		'OC Transpo does not publish its service alerts as open data. It posts them on its website.',
	);
	await expect(live.getByRole('link', { name: 'Read the notices' })).toHaveCount(0);
	await expect(live.getByRole('link', { name: 'Check the official notices' })).toHaveAttribute(
		'href',
		'https://www.octranspo.com/en/alerts/',
	);

	await page.getByTestId('language-toggle').click();
	await expect(page).toHaveURL((url) => url.pathname === '/fr' && isOttawaLive(url));
	await expect(main.getByRole('heading', { level: 1 })).toHaveAccessibleName('Réseau d’Ottawa');
	await expect(main.getByRole('article').first()).toHaveAccessibleName('En direct');
	await expect(
		main.getByRole('heading', { name: 'À propos des chiffres en direct' }),
	).toBeVisible();
});
