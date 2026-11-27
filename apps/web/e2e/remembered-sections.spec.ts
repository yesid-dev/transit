import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { copy as mapCopy } from '../src/lib/features/map/map.copy';
import { DEFAULT_LOCALE } from '../src/lib/i18n/config';
import { openMapControls } from './map-frame-controls';

test.use({ storageState: { cookies: [], origins: [] } });
const b9 = JSON.parse(
	readFileSync(new URL('../scripts/__fixtures__/b9/rich.json', import.meta.url), 'utf8'),
);
const stop = JSON.parse(readFileSync(new URL('./stops-index.json', import.meta.url), 'utf8'))
	.stops[0].id;
const action = (page: Page) => page.getByTestId('sections-toggle').filter({ visible: true });
test.beforeEach(async ({ page }) => {
	await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
	await page.clock.setFixedTime(Date.parse(b9.frozen_utc) + 30_000);
});

test('metrics starts expanded and remembers the bulk choice across pages and reload', async ({
	page,
}) => {
	await page.goto('/metrics/archive');
	await expect(action(page)).toHaveAccessibleName('Collapse all');
	const first = page.locator('[data-testid="metrics-sections"] [data-section-trigger]').first();
	await expect(first).toHaveAttribute('aria-expanded', 'true');
	expect(await page.evaluate(() => localStorage.getItem('sections-choice'))).toBeNull();
	await action(page).click();
	await expect(first).toHaveAttribute('aria-expanded', 'false');
	await page.goto('/stop/' + stop + '?frameMode=live');
	await expect(action(page)).toHaveCount(0);
	await page.goBack();
	await expect(action(page)).toHaveAccessibleName('Expand all');
	await action(page).click();
	await page.reload();
	await expect(action(page)).toHaveAccessibleName('Collapse all');
	expect(await page.evaluate(() => localStorage.getItem('sections-choice'))).toBe('expanded');
});
test.describe('local data fixture rendering', () => {
	test.use({ bypassCSP: true });
	test('stored collapse leaves map tools usable and outside the bulk action', async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem('sections-choice', 'collapsed'));
		await page.goto('/map');
		await expect(action(page)).toHaveCount(0);
		const t = mapCopy[DEFAULT_LOCALE];
		await openMapControls(page);
		const near = page.getByRole('button', { name: 'Near an address', exact: true });
		await near.click();
		await expect(page.getByRole('combobox', { name: t.nearMeAddressLabel })).toBeVisible();
		expect(await page.evaluate(() => localStorage.getItem('sections-choice'))).toBe('collapsed');
	});
});
