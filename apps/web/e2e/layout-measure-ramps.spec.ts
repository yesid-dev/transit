import { expect } from '@playwright/test';
import { test } from './layout-test';
import { expectRampLightness } from './measure-ramp-checks';

test('the late-share hour grid has five legible swatches in order @layout', async ({
	page,
}, info) => {
	await page.goto(
		'/network?provider=stm&frameMode=record&recordFrom=2026-11-20&recordTo=2026-11-22',
	);
	const grid = page.locator('#hours [data-slot="hour-grid"]');
	await expect(grid.locator('tbody [data-level]').first()).toBeVisible();
	await expectRampLightness(
		grid.locator('ul[role="list"] [data-level]'),
		info.project.use.colorScheme === 'dark' ? 'dark' : 'light',
	);
});
