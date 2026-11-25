import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { test } from './layout-test';
import { captureFixture, captureUrl, captureVehicle } from './capture-fixture';
import { designPassCases } from './design-pass-cases';
import { recordMapFixture } from './map-record-fixture';
import { measureDesignPass, setWidth } from './design-pass-measure';
import { expectDesignPass } from './design-pass-debt';

const time = Date.parse('2026-11-23T16:00:00Z');

for (const { screen, provider, locale, key, href } of designPassCases) {
	test(`${screen} ${provider} ${locale} @layout`, async ({ page }, info) => {
		await setWidth(page, 1440);
		await page.clock.setFixedTime(time);
		await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
		await page.route(captureUrl, (route) => {
			const city = new URL(route.request().url()).searchParams.get('city')!;
			return route.fulfill({
				json: captureFixture(time, { city, vehicle_positions: [captureVehicle(time)] }),
			});
		});
		if (screen.startsWith('map-record')) await recordMapFixture(page);
		const response = await page.goto(href);
		expect(response?.status(), href).toBe(screen === 'error' ? 404 : 200);
		await expect(page.locator('html')).toHaveAttribute('lang', locale);
		await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
		await expect(page.getByRole('main')).toBeVisible();
		if (screen === 'how-we-measure') {
			await expect(page.locator('[data-record-disclosure]').first()).toBeVisible();
		}
		if (screen.startsWith('overview')) {
			await expect(page.locator('[data-slot="record-ranking"] li')).toHaveCount(6);
			await expect(page.locator('[data-slot="chart-line-series"]')).toBeVisible();
		}
		if (screen === 'stop-record') {
			await expect(page.locator('[data-slot="hour-grid"]')).toBeVisible();
			await expect(
				page.locator('#daily [data-slot="chart-line-series"][data-reference]'),
			).toBeAttached();
		}
		if (screen === 'download') {
			await expect(page.locator('[data-slot="record-card"]').first()).toBeVisible();
		}
		if (screen.startsWith('map-')) {
			// The app exposes the live map and makes the poster inert at this handoff.
			// Later source updates can make MapLibre's loaded() false again.
			await expect(page.locator('[data-map-progressive-state]')).toHaveAttribute(
				'data-map-progressive-state',
				'ready',
			);
			if (screen.startsWith('map-record')) {
				await expect(
					page.getByRole('main').getByRole('searchbox', {
						name: /^(Find a (stop|segment)|Trouver un (arrêt|segment))$/,
					}),
				).toBeVisible();
			}
		}
		const start = performance.now();
		const redesignedDetail =
			screen === 'departure' || screen === 'vehicle-record' || screen === 'vehicle-live';
		if (redesignedDetail)
			await expect(
				page.locator('[data-slot="screen-answer"] [data-slot="answer-lead"]'),
			).toBeVisible();
		// Adopted Overview checks the actual indicator. Existing debt fingerprints count outlines.
		const { report, focusSequences } = await measureDesignPass(page, {
			countShadowRings:
				redesignedDetail ||
				screen.startsWith('overview') ||
				screen === 'stop-record' ||
				screen === 'how-we-measure' ||
				screen === 'download' ||
				screen === 'roadmap' ||
				screen === 'line-record',
		});
		await info.attach('design-pass-measurements', {
			body: JSON.stringify({
				key,
				ms: Math.round(performance.now() - start),
				report,
				focusSequences,
			}),
			contentType: 'application/json',
		});
		const seconds =
			screen === 'how-we-measure' ? String.raw`(?<!\b90 )(?:seconds|secondes)` : 'seconds|secondes';
		const machineUnits = new RegExp(
			String.raw`\b(?:\d+ s (?:late|early)|${seconds}|\d+\s+(?:second|seconde))\b|\b\d{2}:\d{2}:\d{2} ·|\bDirection [01]\b`,
			'i',
		);
		await expect(page.getByRole('main')).not.toContainText(machineUnits);
		expectDesignPass(screen, key, report);
		if (redesignedDetail || screen === 'download' || screen === 'roadmap') {
			for (const theme of ['light', 'dark'] as const) {
				await page.evaluate((theme) => localStorage.setItem('theme', theme), theme);
				await page.reload();
				await expect(page.locator('[data-slot="screen-answer"]')).toBeVisible();
				const { violations } = await new AxeBuilder({ page })
					.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
					.analyze();
				expect(
					violations.map(({ id, nodes }) => ({ id, targets: nodes.map(({ target }) => target) })),
					theme,
				).toEqual([]);
			}
		}
	});
}
