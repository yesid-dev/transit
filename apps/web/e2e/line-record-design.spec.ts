import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.use({ bypassCSP: true });
test.beforeEach(({ browserName }, info) => {
	test.skip(browserName !== 'chromium' || info.project.name !== 'desktop');
});

const dates = 'frameMode=record&recordFrom=2026-11-08&recordTo=2026-11-14';

test('Line Record places the answer and two charts at the top', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/lines/24?provider=stm&' + dates);
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

for (const { id, state } of [
	{ id: 'm2', state: 'no_live_data' },
	{ id: '715', state: 'not_measured' },
]) {
	test(`Line Record ${id} shows the timetable with a state in place of a figure`, async ({
		page,
	}) => {
		await page.goto(`/lines/${id}?provider=stm&` + dates);
		await expect(page.locator('#punctuality [data-record-state]')).toHaveAttribute(
			'data-record-state',
			state,
		);
		await expect(page.locator('#punctuality')).not.toContainText(/\d\s*%/u);
		await expect(page.locator('#schedule')).toContainText('Morning peak');
		await expect(page.locator('#daily')).toHaveCount(0);
		if (id === 'm2')
			await expect(page.getByRole('heading', { name: 'What cannot be measured' })).toBeVisible();
		else await expect(page.locator('#punctuality')).toContainText('without trip identifiers');
	});
}

for (const theme of ['light', 'dark'] as const) {
	test(`Line Record is accessible in ${theme} at 390px and 200% text`, async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.addInitScript((theme) => localStorage.setItem('theme', theme), theme);
		await page.goto('/fr/lines/24?provider=stm&' + dates);
		await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
		await expect(page.locator('#schedule')).toContainText('Pointe du matin');
		await page.addStyleTag({ content: 'html { font-size: 200%; }' });
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
		expect(
			(
				await new AxeBuilder({ page })
					.include('[data-slot="screen-content"]')
					.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
					.analyze()
			).violations,
		).toEqual([]);
	});
}
