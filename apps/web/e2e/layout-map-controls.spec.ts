import { test } from './layout-test';
import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
	closeMapControls,
	openMapControls,
	openMapLegend,
	closeMapInView,
} from './map-frame-controls';

for (const provider of ['stm', 'octranspo'])
	for (const locale of ['en', 'fr']) {
		test(`${provider} ${locale} map controls align and work by keyboard @layout`, async ({
			page,
		}) => {
			await page.goto(`${locale === 'fr' ? '/fr' : ''}/map?provider=${provider}`, {
				waitUntil: 'networkidle',
			});
			await openMapControls(page);
			await page.locator('[data-map-filter-trigger]').click();
			const panel = page.locator('.map-filters:visible');
			const stop = panel.getByRole('checkbox', {
				name: locale === 'fr' ? 'Arrêt' : 'Stop',
				exact: true,
			});
			await expect(stop).toHaveAttribute('aria-checked', 'false');
			await stop.press('Space');
			await expect(stop).toHaveAttribute('aria-checked', 'true');
			await expect(page).toHaveURL(/[?&]entity=stop(?:&|$)/);
			await stop.press('Enter');
			await expect(stop).toHaveAttribute('aria-checked', 'false');
			const heading = panel.locator('[data-filter-group="markers"] .mf-group-trigger');
			const row = await stop.boundingBox();
			const header = await heading.boundingBox();
			expect(Math.abs(row!.x - header!.x)).toBeLessThan(1);
			expect(Math.abs(row!.width - header!.width)).toBeLessThan(1);
			expect(row!.height).toBeGreaterThanOrEqual(44);
			expect(await stop.evaluate((el) => getComputedStyle(el).borderRadius)).toBe('0px');
			expect((await new AxeBuilder({ page }).include('.map-filters').analyze()).violations).toEqual(
				[],
			);
		});
	}

for (const locale of ['en', 'fr'])
	test(`${locale} map legend has its own aligned surface @layout`, async ({ page }) => {
		await page.goto(`${locale === 'fr' ? '/fr' : ''}/map`, { waitUntil: 'networkidle' });
		const phone = page.viewportSize()!.width < 1024;
		const name = locale === 'fr' ? 'Légende' : 'Legend';
		const card = page.locator(`[data-map-legend="${phone ? 'phone' : 'desktop'}"]`);
		if (phone) {
			const opener = page.getByTestId('map-list-button');
			await expect(opener).toBeVisible();
			const button = (await opener.boundingBox())!;
			expect(button.height).toBeGreaterThanOrEqual(44);
			await openMapLegend(page);
		} else {
			const panel = (await page.locator('[data-frame-controls="desktop"]').boundingBox())!;
			const box = (await card.boundingBox())!;
			expect(box.y).toBeGreaterThan(panel.y + panel.height);
			expect(Math.abs(box.x - panel.x)).toBeLessThanOrEqual(1);
			expect(Math.abs(box.width - panel.width)).toBeLessThanOrEqual(1);
		}
		await expect(card.getByRole('list').first()).toBeVisible();
		const geometry = await card.evaluate((root) => {
			const box = root.getBoundingClientRect();
			const rows = [...root.querySelectorAll('ul > li')];
			return {
				x: box.x,
				right: box.right,
				top: box.top,
				bottom: box.bottom,
				centres: rows.map((row) => {
					const mark = row.firstElementChild!.getBoundingClientRect();
					return mark.x + mark.width / 2;
				}),
				labels: rows.map((row) => row.lastElementChild!.getBoundingClientRect().x),
				clipped: [root, ...rows].some((row) => row.scrollWidth > row.clientWidth + 1),
			};
		});
		for (const value of geometry.centres)
			expect(Math.abs(value - geometry.centres[0])).toBeLessThanOrEqual(1);
		for (const value of geometry.labels)
			expect(Math.abs(value - geometry.labels[0])).toBeLessThanOrEqual(1);
		expect(geometry.clipped).toBe(false);
		expect(geometry.x).toBeGreaterThanOrEqual(0);
		expect(geometry.right).toBeLessThanOrEqual(page.viewportSize()!.width);
		expect(geometry.top).toBeGreaterThanOrEqual(0);
		const surface = phone ? page.locator('[data-map-in-view-sheet]') : card;
		expect(
			(await surface.boundingBox())!.y + (await surface.boundingBox())!.height,
		).toBeLessThanOrEqual(page.viewportSize()!.height);
		expect(
			(
				await new AxeBuilder({ page })
					.include(`[data-map-legend="${phone ? 'phone' : 'desktop'}"]`)
					.analyze()
			).violations,
		).toEqual([]);
		if (phone) {
			await closeMapInView(page);
			await expect(card).toBeHidden();
			await openMapControls(page);
			await closeMapControls(page);
			await openMapLegend(page);
			await expect(card).toBeVisible();
		} else {
			await card.getByRole('button', { name }).click();
			await expect(card.getByRole('button', { name })).toHaveAttribute('aria-expanded', 'false');
			await expect(card.getByRole('list')).toBeHidden();
			expect((await card.boundingBox())!.height).toBeLessThan(geometry.bottom - geometry.top);
		}
	});
