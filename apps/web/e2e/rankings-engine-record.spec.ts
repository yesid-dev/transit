import { expect, test } from '@playwright/test';
import { textDefects } from './layout-helpers';

test.use({ bypassCSP: true });

test.beforeEach(({ browserName }, info) => {
	test.skip(browserName !== 'chromium' || info.project.name !== 'desktop');
});

const dates = 'recordFrom=2026-11-08&recordTo=2026-11-14';
const lists = [
	['hotspots', 'line', 'Lines', 'Lignes', /24/, /48\s?%/, /38\s?% (?:to|à) 58\s?%/],
	['hotspots', 'stop', 'Stops', 'Arrêts', /S1/, /48\s?%/, /38\s?% (?:to|à) 58\s?%/],
	[
		'repeat-offenders',
		'departure',
		'Departures',
		'Départs',
		/07:15:00/,
		/48\s?%/,
		/38\s?% (?:to|à) 58\s?%/,
	],
	[
		'repeat-offenders',
		'vehicle',
		'Vehicles',
		'Véhicules',
		/V01/,
		/24[.,]39 (?:per|par) 100 h/,
		/Unknown|Inconnu/,
	],
] as const;

for (const locale of ['en', 'fr'] as const) {
	const fr = locale === 'fr';
	test(`${locale} ranks all four lists at phone and desktop widths`, async ({ page, request }) => {
		await page.setViewportSize({ width: 390, height: 900 });
		const prefix = fr ? '/fr' : '';
		await page.goto(`${prefix}/hotspots?provider=stm&${dates}`);
		const documentStart = await page.evaluate(() => performance.timeOrigin);
		const main = page.getByRole('main');

		for (const [path, kind, en, frLabel, identity, value, range] of lists) {
			const label = fr ? frLabel : en;
			await test.step(label, async () => {
				if (kind !== 'line') await main.getByRole('radio', { name: label, exact: true }).click();
				await expect(page).toHaveURL((url) => url.pathname === `${prefix}/${path}`);
				const title =
					path === 'hotspots'
						? fr
							? 'Points chauds'
							: 'Hotspots'
						: fr
							? 'Récidivistes'
							: 'Repeat offenders';
				await expect(main.getByRole('heading', { level: 1, name: title })).toBeVisible();
				const section = main.getByRole('region', { name: label, exact: true });
				const row = section.getByRole('listitem').filter({ hasText: identity }).first();
				const exclusions = section.getByText(
					fr ? /Exclusions et motifs/ : /Excluded, with the reason/,
				);
				const cite = section.getByText(fr ? 'Citer' : 'Cite', { exact: true });
				await exclusions.click();
				await cite.click();
				for (const width of [390, 1440]) {
					await test.step(`${width}px`, async () => {
						await page.setViewportSize({ width, height: 900 });
						await expect(row).toContainText(value);
						await expect(row).toContainText(range);
						if (kind !== 'vehicle')
							await expect(row).toContainText(fr ? 'Faible couverture' : 'Low coverage');
						await expect(section).toContainText(fr ? 'Le minimum' : 'Minimum to rank');
						await expect(
							section.getByText(fr ? /Trop peu pour juger/ : /Too few to judge/),
						).toBeVisible();
						await expect(
							section.getByRole('button', { name: fr ? 'Copier le lien' : 'Copy link' }),
						).toBeVisible();
						await expect(section.getByText(/rankings-fixture-v1.*#ranking/)).toBeVisible();
						const defects = await textDefects(page);
						expect(defects.filter(({ selector }) => selector.startsWith('#ranking'))).toEqual([]);
						expect(await main.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(
							width,
						);
					});
				}
				const csv = await section.getByRole('link', { name: /CSV/ }).getAttribute('href');
				const response = await request.get(csv!);
				expect(response.ok()).toBeTruthy();
				expect(await response.text()).toMatch(fr ? /^Rang,Type,Identifiant/ : /^Rank,Kind,ID/);
				if (kind === 'vehicle') {
					const measures = main.getByRole('combobox', {
						name: fr ? 'Mesure' : 'Measure',
						exact: true,
					});
					await expect(measures.locator('option')).toHaveText([
						fr ? 'Interruptions de signalement' : 'Stopped reporting',
					]);
					await expect(measures).toHaveValue('vehicle_reporting_gaps_per_100_hours');
				}
				await cite.click();
				await exclusions.click();
			});
		}
		expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentStart);
	});
}

test('selects the two deeper line rankings with their own evidence floors', async ({ page }) => {
	await page.goto(`/hotspots?provider=stm&${dates}`);
	await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
	const measures = page.getByRole('combobox', { name: 'Measure', exact: true });
	const lines = page.getByRole('region', { name: 'Lines', exact: true });
	await measures.selectOption('excess_wait_time');
	await expect(page).toHaveURL(/measure=excess_wait_time/);
	await expect(lines.getByText('42.5 s', { exact: true })).toBeVisible();
	await expect(lines).toContainText('50 observed intervals and 20 distinct observed trip pairs');
	await expect(lines).toContainText('40% coverage of 250 scheduled intervals');
	await measures.selectOption('early');
	await expect(page).toHaveURL(/measure=early/);
	await expect(lines.getByText('4%', { exact: true })).toBeVisible();
	await expect(lines).toContainText('100 observed stop events and 20 observed trips');
	await expect(lines).toContainText('4 in 100 observed stop events');
});

test('explains the sample floor for an empty departure ranking', async ({ page }) => {
	await page.goto('/repeat-offenders?provider=stm&recordFrom=2026-11-08&recordTo=2026-11-08');
	const ranking = page.getByRole('region', { name: 'Departures', exact: true });
	await expect(ranking).toContainText('No departures qualified.');
	await expect(ranking).toContainText('5 observed service dates and 30 observed stop events');
});

test('changes dates, class, measure and list while keeping the ranking URL shareable', async ({
	page,
}) => {
	await page.goto(`/hotspots?provider=stm&${dates}`);
	await page.getByRole('combobox', { name: 'Service class' }).selectOption('all');
	await expect(page).toHaveURL(/class=all/);
	await expect(
		page
			.getByText('Regular service (GTFS type 3)', { exact: true })
			.filter({ visible: true })
			.last(),
	).toBeVisible();
	await page.getByRole('combobox', { name: 'Measure', exact: true }).selectOption('median_delay');
	await expect(page.getByText('27.5 s to 32.5 s')).toBeVisible();
	await expect(page.getByText('Bin rounding only', { exact: true })).toBeVisible();
	await page.getByRole('radio', { name: 'Vehicles', exact: true }).click();
	await expect(page).toHaveURL(/repeat-offenders.*kind=vehicle/);
	await expect(page.getByText('24.39 per 100 h')).toBeVisible();
	await page.getByRole('button', { name: /^Period/ }).click();
	await page.getByLabel('From', { exact: true }).fill('2026-11-10');
	await page.getByRole('button', { name: 'Show these dates' }).click();
	await expect(page.getByText('Not tracked', { exact: true })).toBeVisible();
});

test('a slow ranking streams patience and completes without reloading', async ({
	page,
	request,
}) => {
	const response = await page.goto(
		'/hotspots?provider=stm&recordFrom=2026-11-09&recordTo=2026-11-14',
		{
			waitUntil: 'commit',
		},
	);
	expect(response?.headers()['cache-control']).toBe('no-store, no-transform');
	await expect(page.getByRole('heading', { name: 'Hotspots', exact: true })).toBeVisible();
	await expect(
		page.getByText('Still working on this. You can wait or come back later.'),
	).toBeVisible();
	const dataPort = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';
	expect(
		(
			await request.post(`http://127.0.0.1:${dataPort}/__overview/release?fixture=rankings`)
		).status(),
	).toBe(204);
	await expect(page.getByText('38% to 58%')).toBeVisible();
});
