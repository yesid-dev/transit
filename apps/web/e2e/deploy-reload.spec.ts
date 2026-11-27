import { expect, test } from '@playwright/test';
import { VERSION_POLL_INTERVAL_MS } from '../src/lib/pwa/appVersion';

test('offers reload when version polling detects a deployment in an open tab', async ({ page }) => {
	await page.clock.install();
	await page.goto('/privacy');
	await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
	const notice = page.locator('#app-reload-notice');
	await expect(notice).toBeHidden();
	await page.route('**/_app/version.json*', (route) =>
		route.fulfill({ json: { version: 'new-deployment' } }),
	);
	await page.clock.fastForward(VERSION_POLL_INTERVAL_MS);
	await expect(notice).toContainText('A newer version is available.');
	await expect(notice.getByRole('button', { name: 'Reload' })).toBeVisible();
});

test('offers a French reload when the initial application chunk is unavailable', async ({
	page,
}) => {
	const starter = /\/_app\/immutable\/entry\/start\.[^/]+\.js$/u;
	const manifest = '**/_app/version.json*';
	await page.route(starter, (route) => route.abort());
	await page.route(manifest, (route) => route.fulfill({ json: { version: 'new-deployment' } }));
	await page.goto('/fr/privacy');
	const notice = page.locator('#app-reload-notice');
	await expect(notice).toContainText('Une nouvelle version est disponible.');
	await page.unroute(starter);
	await page.unroute(manifest);
	await notice.getByRole('button', { name: 'Recharger' }).click();
	await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
	await expect(page).toHaveURL(/\/fr\/privacy$/u);
	await expect(notice).toBeHidden();
});
