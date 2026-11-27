import { expect, test } from '@playwright/test';
import { join } from 'node:path';

test.use({ bypassCSP: true, hasTouch: true });

for (const [width, locale, theme] of [
	[1440, 'en', 'light'],
	[1440, 'fr', 'dark'],
	[390, 'en', 'light'],
	[390, 'fr', 'dark'],
] as const) {
	test(`Network chart readings at ${width}px in ${locale} and ${theme}`, async ({
		page,
		browserName,
	}, info) => {
		test.skip(browserName !== 'chromium' || info.project.name !== 'desktop');
		await page.setViewportSize({ width, height: 900 });
		await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
		await page.addInitScript((value) => localStorage.setItem('theme', value), theme);
		const fr = locale === 'fr';
		const path = fr ? '/fr/network' : '/network';
		await page.goto(
			path + '?provider=stm&frameMode=record&recordFrom=2026-11-20&recordTo=2026-11-22',
		);
		await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
		await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
		const chart = page.locator('#delay [data-chart-details]');
		const tip = page.getByRole('tooltip');
		const bars = chart.locator('[data-chart-datum]');
		const countLabel = fr ? 'Passages aux arrêts' : 'Stop events';
		const shareLabel = fr ? 'Part' : 'Share';

		await bars.first().hover();
		await expect(tip).toContainText(countLabel);
		await expect(tip).toContainText(shareLabel);
		await expect(tip).toContainText(fr ? /\d,\d\s%/u : /\d\.\d%/u);
		await expect(tip).toHaveCSS('transition-duration', '0s');
		const first = await tip.textContent();
		const output = process.env.TRANSIT_CHARTS_ARTWORK;
		if (output)
			await page.screenshot({ path: join(output, `histogram-${width}-${locale}-${theme}.png`) });

		await page.keyboard.press('Escape');
		await expect(tip).toHaveCount(0);
		await chart.focus();
		await expect(tip).toContainText(countLabel);
		await page.keyboard.press('End');
		await expect(tip).not.toHaveText(first!);

		if (width === 390) {
			await bars.first().tap();
			const details = page.getByRole('dialog');
			await expect(details).toContainText(countLabel);
			await expect(details).toContainText(shareLabel);
			await expect(details).toHaveCSS('animation-name', 'none');
			if (output)
				await page.screenshot({
					path: join(output, `histogram-touch-${width}-${locale}-${theme}.png`),
				});
			await page.keyboard.press('Escape');
			await expect(details).toHaveCount(0);
			await expect(chart).toBeFocused();
		}

		const toggle = page
			.locator('#delay')
			.getByRole('button', { name: fr ? 'Tableau' : 'Table', exact: true });
		await toggle.click();
		await expect(toggle).toHaveAttribute('aria-pressed', 'true');
		await expect(page.locator('#delay').getByRole('table')).toBeVisible();
		await expect(chart).toHaveCount(0);

		const trend = page.locator('#trend [data-chart-details]');
		await trend.locator('[data-chart-datum]').first().hover();
		await expect(tip).toContainText(fr ? 'novembre' : 'November');
		await expect(tip).toContainText(fr ? 'passages aux arrêts' : 'stop events');
		if (output)
			await page.screenshot({ path: join(output, `trend-${width}-${locale}-${theme}.png`) });
		const grid = page.locator('#hours [data-chart-details]');
		const measured = grid
			.locator('tbody td')
			.filter({ has: page.locator('[data-level]') })
			.first();
		await measured.hover();
		await expect(tip).toContainText(fr ? 'Part en retard' : 'Late share');
		await expect(tip).toContainText(fr ? 'passages aux arrêts' : 'stop events');
		if (output)
			await page.screenshot({ path: join(output, `hour-grid-${width}-${locale}-${theme}.png`) });
	});
}
