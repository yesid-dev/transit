import { expect, test } from '@playwright/test';

for (const locale of ['en', 'fr'] as const) {
	test(`${locale}: a slow unknown stop streams into the missing-stop view`, async ({
		page,
		request,
	}) => {
		const en = locale === 'en';
		const fixture = `http://127.0.0.1:${process.env.TRANSIT_E2E_DATA_PORT ?? '4318'}`;
		await page.setExtraHTTPHeaders({ 'x-transit-fixture-scope': 'stops-search' });
		await request.post(`${fixture}/__stops-search`);
		try {
			const response = await page.goto(
				`${en ? '' : '/fr'}/stop/57135?provider=stm&frameMode=record`,
				{ waitUntil: 'commit' },
			);
			expect(response?.status()).toBe(200);
			await expect(
				page.getByRole('heading', { name: en ? 'Stop 57135' : 'Arrêt 57135' }),
			).toBeVisible();
			await request.post(`${fixture}/__overview/release?fixture=stops-search`);
			await expect(
				page.getByRole('heading', {
					name: en ? 'This stop could not be found' : 'Cet arrêt est introuvable',
				}),
			).toBeVisible();
			await expect(page.locator('meta[name="robots"][content="noindex"]')).toHaveCount(1);
		} finally {
			await request.post(`${fixture}/__overview/release?fixture=stops-search`);
		}
	});
}
