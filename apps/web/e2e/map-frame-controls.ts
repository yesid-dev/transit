import { expect, type Locator, type Page } from '@playwright/test';
import { waitForFrameRailLayout } from './frame-controls';

export function mapControlsPill(page: Page) {
	return page.locator('[data-slot="surface-rail-mobile"] button').first();
}

export async function expectAboveMapSource(page: Page, panel: Locator) {
	const source = page.locator('[data-slot="map-source-footer"]');
	await expect(source).toBeVisible();
	await expect(panel).toBeVisible();
	await expect
		.poll(async () => {
			const [box, footer] = await Promise.all([panel.boundingBox(), source.boundingBox()]);
			return box && footer ? box.y + box.height - footer.y : Number.POSITIVE_INFINITY;
		})
		.toBeLessThanOrEqual(0);
}

export async function openMapControls(page: Page) {
	const layout = await waitForFrameRailLayout(page);
	const pill = mapControlsPill(page);
	if (layout === 'compact' && (await pill.isVisible())) {
		if ((await pill.getAttribute('aria-expanded')) !== 'true') await pill.click();
		await expect(pill).toHaveAttribute('aria-expanded', 'true');
	}
}

export async function closeMapControls(page: Page) {
	const pill = mapControlsPill(page);
	if ((await pill.isVisible()) && (await pill.getAttribute('aria-expanded')) === 'true') {
		await page.keyboard.press('Escape');
		await expect(pill).toHaveAttribute('aria-expanded', 'false');
	}
}

export async function openMapInView(page: Page) {
	await expect(page.getByTestId('map-progressive')).toHaveAttribute(
		'data-map-progressive-state',
		'ready',
	);
	const trigger = page.locator('.map-in-view-button');
	if ((await trigger.isVisible()) && !(await page.locator('[data-map-in-view-sheet]').isVisible()))
		await trigger.click();
}

export async function closeMapInView(page: Page) {
	const sheet = page.locator('[data-map-in-view-sheet]');
	if (await sheet.isVisible()) {
		await page.keyboard.press('Escape');
		await expect(sheet).toBeHidden();
	}
}
