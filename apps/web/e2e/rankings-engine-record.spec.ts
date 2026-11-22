import { expect, test } from '@playwright/test';

test.use({ bypassCSP: true });

test.beforeEach(({ browserName }, info) => {
	test.skip(browserName !== 'chromium' || info.project.name !== 'desktop');
});

const dates = 'recordFrom=2026-11-08&recordTo=2026-11-14';
const lists = [
	['hotspots', '', 'Lines', 'Lignes', /24/, /48\s?%/, /38\s?% (?:to|à) 58\s?%/],
	['hotspots', 'stop', 'Stops', 'Arrêts', /S1/, /48\s?%/, /38\s?% (?:to|à) 58\s?%/],
	['repeat-offenders', '', 'Departures', 'Départs', /07:15:00/, /48\s?%/, /38\s?% (?:to|à) 58\s?%/],
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

for (const width of [390, 1440]) {
	for (const locale of ['en', 'fr'] as const) {
		for (const [path, kind, en, frLabel, identity, value, range] of lists) {
			const fr = locale === 'fr';
			const label = fr ? frLabel : en;
			test(`${locale} at ${width}px ranks ${en.toLowerCase()}`, async ({ page, request }) => {
				await page.setViewportSize({ width, height: 900 });
				await page.goto(
					`${fr ? '/fr' : ''}/${path}?provider=stm&${dates}${kind ? `&kind=${kind}` : ''}`,
				);
				const main = page.getByRole('main');
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
				await expect(row).toContainText(value);
				await expect(row).toContainText(range);
				await expect(section).toContainText(fr ? 'Le minimum' : 'Minimum to rank');
				await section.getByText(fr ? /Exclusions et motifs/ : /Excluded, with the reason/).click();
				await expect(
					section.getByText(fr ? /Trop peu pour juger/ : /Too few to judge/),
				).toBeVisible();
				await expect(
					section.getByRole('button', { name: fr ? 'Copier le lien' : 'Copy link' }),
				).toBeVisible();
				await section.getByText(fr ? 'Citer' : 'Cite', { exact: true }).click();
				await expect(section.getByText(/rankings-fixture-v1.*#ranking/)).toBeVisible();
				const csv = await section.getByRole('link', { name: /CSV/ }).getAttribute('href');
				const response = await request.get(csv!);
				expect(response.ok()).toBeTruthy();
				expect(await response.text()).toMatch(fr ? /^Rang,Type,Identifiant/ : /^Rank,Kind,ID/);
				expect(await main.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(width);
				if (kind === 'vehicle') {
					const measures = main.getByRole('combobox', {
						name: fr ? 'Mesure' : 'Measure',
						exact: true,
					});
					await expect(measures.locator('option')).toHaveCount(2);
				}
			});
		}
	}
}

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
	expect((await request.post(`http://127.0.0.1:${dataPort}/__overview/release`)).status()).toBe(
		204,
	);
	await expect(page.getByText('38% to 58%')).toBeVisible();
});
