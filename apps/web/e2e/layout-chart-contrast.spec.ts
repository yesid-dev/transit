import { test } from './layout-test';
import { expect } from '@playwright/test';
import { openNetwork, statusMarkContrast, weak } from './layout-chart-contrast';

// The 390 and 1280 projects run this file (playwright.config.ts), in both saved themes.
for (const locale of ['en', 'fr'] as const)
	test(`${locale} Network status glyphs keep 3:1 against their surface @layout`, async ({
		page,
	}) => {
		await openNetwork(page, locale);
		const findings = await statusMarkContrast(page);
		const tokens = new Set(findings.map(({ token }) => token));
		for (const token of ['early', 'on-time', 'late', 'unknown']) expect(tokens).toContain(token);
		expect(weak(findings)).toEqual([]);
	});
