import { expect, test } from '@playwright/test';

test.beforeEach(({ browserName }, info) => {
	test.skip(browserName !== 'chromium' || info.project.name !== 'desktop');
});

for (const width of [390, 1440]) {
	for (const locale of ['en', 'fr'] as const) {
		const fr = locale === 'fr';
		test(`${locale} at ${width}px shows the Overview record and its evidence`, async ({ page }) => {
			await page.setViewportSize({ width, height: 900 });
			await page.goto(
				`${fr ? '/fr' : '/'}?provider=${fr ? 'octranspo' : 'stm'}&frameMode=record&recordFrom=2026-11-08&recordTo=2026-11-14`,
			);
			const main = page.getByRole('main');
			const punctuality = main.getByRole('region', {
				name: fr ? 'Ponctualité' : 'On-time performance',
			});
			const previous = main.getByRole('region', {
				name: fr ? 'Période précédente' : 'Previous period',
			});
			const service = main.getByRole('region', {
				name: fr ? 'Service effectué' : 'Service delivered',
			});
			await expect(main.getByRole('heading', { level: 1 })).toHaveText(
				fr ? 'Aperçu · Ottawa' : 'Overview · Montréal',
			);
			await expect(
				punctuality.getByText(fr ? /70\s% des passages/ : /81\.2% of observed stop events/),
			).toBeVisible();
			await expect(
				previous.getByText(fr ? /400\s000 sur 507\s800/ : /400,000 of 507,800/),
			).toBeVisible();
			await expect(main.getByText(fr ? /Écart de/ : /Change of/)).toBeVisible();
			await expect(
				punctuality.getByRole('heading', { name: fr ? 'Départs en avance' : 'Early departures' }),
			).toBeVisible();
			await expect(punctuality).toContainText(
				fr ? /10\s% \(50\s780\/507\s800\)/ : /10% \(50,780\/507,800\)/,
			);
			await expect(punctuality).toContainText(fr ? 'manque le véhicule' : 'misses the vehicle');
			await expect(previous).toContainText(fr ? '80 % des jours mesurés' : '80% of days measured');
			await expect(punctuality).toContainText(fr ? 'Faible couverture' : 'Low coverage');
			await expect(punctuality).toContainText(
				fr
					? 'La plupart de ces heures proviennent de prévisions.'
					: 'Most times come from predictions.',
			);
			await expect(service.getByText(fr ? /90 sur 100/ : /90 of 100/)).toBeVisible();
			await expect(main.getByRole('listitem')).toHaveCount(6);
			await expect(
				main.getByRole('button', { name: fr ? 'Copier le lien' : 'Copy link' }),
			).toBeVisible();
			await main.getByText(fr ? 'Citer' : 'Cite', { exact: true }).click();
			await expect(main.getByText(/punctuality-v2/).first()).toBeVisible();
			expect(await main.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(width);
		});
	}
}

test('a slow stop ranking shows patience while the other parts remain usable', async ({
	page,
	request,
}) => {
	await page.goto('/?provider=stm&frameMode=record&recordFrom=2026-11-09&recordTo=2026-11-15', {
		waitUntil: 'commit',
	});
	const main = page.getByRole('main');
	const punctuality = main.getByRole('region', { name: 'On-time performance' });
	await expect(punctuality.getByText(/81\.2% of observed stop events/)).toBeVisible({
		timeout: 10_000,
	});
	await expect(main.getByText(/L3/)).toBeVisible();
	await expect(
		main.getByText('Still working on this. You can wait or come back later.'),
	).toBeVisible();
	await main.getByText('Cite', { exact: true }).click();
	await expect(main.getByText(/punctuality-v2/).first()).toBeVisible();
	const dataPort = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';
	const release = await request.post(`http://127.0.0.1:${dataPort}/__overview/release`);
	expect(release.status()).toBe(204);
	await expect(main.getByText('S3', { exact: true })).toBeVisible();
	await expect(
		main.getByText('Still working on this. You can wait or come back later.'),
	).toHaveCount(0);
});

test('changing the custom period reloads Record and Live now still opens the existing homepage', async ({
	page,
}) => {
	await page.goto('/?provider=stm&recordFrom=2026-11-08&recordTo=2026-11-14');
	const main = page.getByRole('main');
	const punctuality = main.getByRole('region', { name: 'On-time performance' });
	await expect(punctuality.getByText(/November 8 to 14, 2026/)).toBeVisible();
	await page.getByRole('button', { name: /^Period/ }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel('From', { exact: true }).fill('2026-11-08');
	await dialog.getByLabel('To', { exact: true }).fill('2026-11-08');
	await dialog.getByRole('button', { name: 'Show these dates' }).click();
	await expect(punctuality.getByText(/On November 8, 2026/)).toBeVisible();
	await expect(page).toHaveURL(/recordTo=2026-11-08/);
	await expect(main.getByRole('region', { name: 'Same weekday last week' })).toContainText(
		'On November 1, 2026',
	);
	await page.getByRole('radio', { name: 'Live now' }).click();
	await expect(main.getByText(/how the Montréal · STM network actually runs/)).toBeVisible();
	await expect(main.getByRole('navigation', { name: 'Explore everything' })).toBeVisible();
	await page.goBack();
	await expect(punctuality.getByText(/On November 8, 2026/)).toBeVisible();
});
