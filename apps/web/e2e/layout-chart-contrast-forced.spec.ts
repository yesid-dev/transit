import { test } from './layout-test';
import { expect } from '@playwright/test';
import { openNetwork, statusMarkContrast, weak } from './layout-chart-contrast';

// Playwright emulates forced colours in Chromium only, so the Chromium 1280 light and dark
// projects run this file (playwright.config.ts); they supply the saved theme.
for (const forced of ['light', 'dark'] as const)
	test(`status chart marks keep 3:1 against Canvas in forced ${forced} colours @layout`, async ({
		page,
	}) => {
		await openNetwork(page, 'en');
		await page.emulateMedia({ forcedColors: 'active', colorScheme: forced });
		const findings = await statusMarkContrast(page);
		expect(findings.length).toBeGreaterThan(0);
		expect(weak(findings)).toEqual([]);
	});
