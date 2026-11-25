import { closeCompactFrameControls, openFrameControls } from './frame-controls';
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { captureFixture, captureUrl, captureVehicle } from './capture-fixture';

test.beforeEach(({ browserName }, info) => {
	test.skip(browserName !== 'chromium' || info.project.name !== 'desktop');
});

const period = 'recordFrom=2026-11-08&recordTo=2026-11-14';
const recordHref = '/?provider=stm&frameMode=record&' + period;

test('the desktop French total stays on one line and plate codes keep names aligned', async ({
	page,
}) => {
	const now = Date.now();
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.clock.setFixedTime(now);
	await page.route(captureUrl, (route) =>
		route.fulfill({
			json: captureFixture(now, { vehicle_positions: [captureVehicle(now, { delay: 420 })] }),
		}),
	);
	await page.goto('/fr' + recordHref);
	const total = page
		.getByRole('article', { name: 'Bilan', exact: true })
		.getByText(/^sur 507\s800 passages aux arrêts$/u);
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
			.getByRole('listitem')
			.filter({ has: page.locator('[data-slot="route-plate"]') })
			.first(),
		page
			.getByRole('article', { name: 'En direct', exact: true })
			.getByRole('listitem')
			.filter({ has: page.locator('[data-slot="route-plate"]') })
			.first(),
	]) {
		await expect(row).toBeVisible();
		const name = row.getByRole('link');
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
	await page.route(captureUrl, async (route) => {
		await held;
		await route.fulfill({ status: 503, body: '{}' });
	});
	try {
		await page.goto(recordHref);
		const live = page.getByRole('article', { name: 'Live now' });
		await expect(live.locator('[data-slot="skeleton"]')).toHaveCount(3);
		await expect(live).not.toContainText('No live data');
		release();
		await expect(live.getByText('Live numbers unavailable', { exact: true })).toHaveCount(1);
		await expect(live.getByText('Unavailable', { exact: true })).toHaveCount(2);
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
		await expect(live.locator('[data-slot="skeleton"]')).toHaveCount(3);
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
	const dialog = page.getByRole('dialog', { name: 'Period', exact: true });
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
		await expect(record.getByText('Calculating…').first()).toBeVisible();
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
				await expect(main.getByRole('heading', { level: 1 })).toHaveText(title);
				await expect(
					record.getByText(provider === 'stm' ? /81[,.]2\s?%/ : /70\s?%/, { exact: true }).first(),
				).toBeVisible();
				await expect(record).toContainText(fr ? /90 sur 100/ : /90 of 100/);
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
				await expect(ranking.getByRole('listitem')).toHaveCount(6);
				await expect(ranking.getByRole('link')).toHaveCount(7);

				const firstLink = record.getByRole('link').first();
				const copy = record.getByRole('button', { name: fr ? 'Copier le lien' : 'Copy link' });
				const frameEnd = page.getByRole('button', {
					name:
						width === 390
							? fr
								? /^Commandes.*Ouvrir les commandes/
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
				await page.keyboard.press('Tab');
				await expect(firstLink).toBeFocused();

				await download.click();
				const exports = page.getByRole('dialog');
				await expect(exports.getByRole('link')).toHaveCount(6);
				const exportHref = await exports.getByRole('link').first().getAttribute('href');
				const csv = await request.get(exportHref!);
				expect(await csv.text()).toBe('measure,from,to\npunctuality,2026-11-08,2026-11-14\n');
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
				await page.goto(`${fr ? '/fr' : '/'}?provider=${provider}&frameMode=record&${period}`);
				await expect(page.locator('html')).toHaveAttribute('data-theme', colorScheme);
				await expect(
					page.getByRole('heading', {
						name: fr ? 'À propos de ces chiffres' : 'About these figures',
					}),
				).toBeVisible();
				const results = await new AxeBuilder({ page })
					.include('main')
					.withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
					.analyze();
				expect(results.violations).toEqual([]);
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
	await expect(main.getByText('These records take longer')).toBeVisible();
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
		main.getByRole('article', { name: 'Lines and stops to investigate' }).getByRole('listitem'),
	).toHaveCount(6);
	await expect(main.getByText('These records take longer')).toHaveCount(0);
});

test('Live and Record show the same punctuality for the same week (OV1)', async ({ page }) => {
	await page.goto(recordHref);
	const main = page.getByRole('main');
	const reading = main
		.getByRole('article', { name: 'Record', exact: true })
		.getByText('81.2%', { exact: true })
		.first();
	await expect(reading).toBeVisible();
	const value = await reading.innerText();
	await (await openFrameControls(page)).getByRole('radio', { name: 'Live now' }).click();
	await closeCompactFrameControls(page);
	await expect(page).toHaveURL(/frameMode=live/);
	await expect(main.getByRole('region', { name: 'Record for the selected period' })).toContainText(
		value,
	);
});

test('changing the custom period reloads Record and Live now still opens the existing homepage', async ({
	page,
}) => {
	await page.goto('/?provider=stm&' + period);
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
	const main = page.getByRole('main');
	const record = main.getByRole('article', { name: 'Record', exact: true });
	await expect(record.getByText('Record · 8 to 14 Nov 2026').first()).toBeVisible();
	await (await openFrameControls(page)).getByRole('button', { name: 'Choose other dates' }).click();
	const dialog = page.getByRole('dialog', { name: 'Period', exact: true });
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
	await expect(main.getByText(/how the Montréal · STM network actually runs/)).toBeVisible();
	await expect(main.getByRole('navigation', { name: 'Explore everything' })).toBeVisible();
	await page.goBack();
	await expect(record.getByText('Record · 8 Nov 2026').first()).toBeVisible();
});
