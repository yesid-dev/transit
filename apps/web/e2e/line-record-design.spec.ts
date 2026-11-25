import { expect, test } from '@playwright/test';

test.use({ bypassCSP: true });

test('Line Record places the answer and two charts at the top', async ({ page }, info) => {
	test.skip(info.project.name !== 'desktop');
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(
		'/lines/24?provider=stm&frameMode=record&recordFrom=2026-11-08&recordTo=2026-11-14',
	);
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
	const main = page.getByRole('main');
	await expect(main.getByRole('heading', { level: 1 })).toHaveCount(1);
	await expect(main.locator('[data-slot="screen-answer"]')).toContainText('80%');
	for (const title of ['Early, on time and late', 'Day by day']) {
		const bounds = await main.getByRole('heading', { name: title, exact: true }).boundingBox();
		expect(bounds!.y + bounds!.height).toBeLessThan(900);
	}
	const hours = main.locator('[data-slot="hour-grid"]');
	await expect(hours.getByRole('table')).toBeVisible();
	expect((await hours.boundingBox())!.height).toBeLessThan(420);
});
