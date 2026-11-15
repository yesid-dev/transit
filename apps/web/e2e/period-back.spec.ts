import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const fixture = JSON.parse(
	readFileSync(new URL('../scripts/__fixtures__/b9/rich.json', import.meta.url), 'utf8'),
);
const line = JSON.parse(readFileSync(new URL('./routes-index.json', import.meta.url), 'utf8'))
	.routes[0];

test.use({ bypassCSP: true });
test.beforeEach(async ({ page }) => {
	await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
	await page.clock.setFixedTime(Date.parse(fixture.frozen_utc) + 30_000);
});

for (const entity of [
	{ path: `/lines/${line.id}`, period: 'Date range' },
	{ path: '/stop/S1', period: 'Day' },
]) {
	test(`${entity.path}: Back from a menu link restores the rendered tab and period`, async ({
		page,
	}) => {
		await page.goto(`${entity.path}?provider=stm`);
		await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
		const title = await page.getByRole('heading', { level: 1 }).textContent();
		const record = page.getByRole('tab', { name: 'Record', exact: true });
		await record.click();
		const phone = (page.viewportSize()?.width ?? 1440) < 1024;
		if (phone) await page.getByRole('button', { name: /^View .*Open view/ }).click();
		const period = page.getByRole('radio', { name: entity.period, exact: true });
		await period.click();
		if (entity.period === 'Date range') {
			await page.locator('input[name="history-from"]').fill('2026-08-26');
			await page.locator('input[name="history-to"]').fill('2026-08-29');
		}
		await expect(period).toBeChecked();
		await expect(page).toHaveURL((url) =>
			entity.period === 'Day'
				? url.searchParams.get('grain') === 'day'
				: url.searchParams.get('from') === '2026-08-26' &&
					url.searchParams.get('to') === '2026-08-29',
		);
		if (phone) await page.keyboard.press('Escape');
		await page.getByRole('button', { name: 'Open menu', exact: true }).click();
		await page
			.getByRole('navigation', { name: 'Navigation menu' })
			.getByRole('link', { name: 'Lines', exact: true })
			.click();
		await expect(page).toHaveURL((url) => url.pathname === '/lines');
		await page.goBack();
		await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
		await expect(record).toHaveAttribute('aria-selected', 'true');
		if (phone) await page.getByRole('button', { name: /^View .*Open view/ }).click();
		await expect(period).toBeChecked();
		if (entity.period === 'Date range') {
			await expect(page.locator('input[name="history-from"]')).toHaveValue('2026-08-26');
			await expect(page.locator('input[name="history-to"]')).toHaveValue('2026-08-29');
		}
	});
}
