import { test } from './layout-test';
import { expect } from '@playwright/test';
import { openNetwork, statusMarkContrast, weak } from './layout-chart-contrast';

// The 390 and 1280 projects run this file (playwright.config.ts), in both saved themes.
for (const locale of ['en', 'fr'] as const)
	test(`${locale} status chart marks keep 3:1 against their surface @layout`, async ({ page }) => {
		await openNetwork(page, locale);
		const findings = await statusMarkContrast(page);
		const tokens = new Set(findings.map(({ token }) => token));
		for (const token of ['early', 'on-time', 'unknown']) expect(tokens).toContain(token);
		// v0.51.0 gives late and severe one colour, so either name labels it.
		expect(tokens.has('late') || tokens.has('severe')).toBe(true);
		expect(weak(findings)).toEqual([]);
	});
