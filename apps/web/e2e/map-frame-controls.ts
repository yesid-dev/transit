import { expect, type Locator, type Page } from '@playwright/test';
import { waitForFrameRailLayout } from './frame-controls';

export function mapControlsPill(page: Page) {
	return page.getByTestId('map-controls-button');
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
	await expect(page.getByTestId('map-progressive')).toHaveAttribute(
		'data-map-progressive-state',
		'ready',
	);
	const layout = await waitForFrameRailLayout(page);
	if (layout === 'compact') {
		const sheet = page.locator('[data-map-in-view-sheet]');
		// The sheet stays visible during its exit animation after Escape.
		const openSheet = sheet.and(page.locator('[data-state="open"]'));
		if (await openSheet.isVisible()) {
			await openSheet.getByRole('tab', { name: /^(Controls|Options)$/u }).click();
		} else {
			await expect(sheet).toBeHidden();
			await mapControlsPill(page).click();
		}
		await expect(sheet.locator('[data-frame-controls="mobile"]')).toBeVisible();
	}
}

export async function openMapLegend(page: Page) {
	const sheet = page.locator('[data-map-in-view-sheet]');
	if (!(await sheet.isVisible())) await openMapInView(page);
	await sheet.getByRole('tab', { name: /^(Legend|Légende)$/u }).click();
	await expect(page.locator('[data-map-legend="phone"]')).toBeVisible();
}

export async function closeMapControls(page: Page) {
	const pill = mapControlsPill(page);
	if ((await pill.isVisible()) && (await pill.getAttribute('aria-expanded')) === 'true') {
		await closeMapInView(page);
		await expect(pill).toHaveAttribute('aria-expanded', 'false');
	}
}

export async function openMapInView(page: Page) {
	await expect(page.getByTestId('map-progressive')).toHaveAttribute(
		'data-map-progressive-state',
		'ready',
	);
	const trigger = page.locator('.map-in-view-button');
	if (!(await trigger.isVisible())) return;
	const sheet = page.locator('[data-map-in-view-sheet]');
	const openSheet = sheet.and(page.locator('[data-state="open"]'));
	if (await openSheet.isVisible()) {
		const list = openSheet.getByRole('tab').first();
		if ((await list.getAttribute('aria-selected')) !== 'true') await list.click();
	} else {
		await expect(sheet).toBeHidden();
		await trigger.click();
	}
}

export async function closeMapInView(page: Page) {
	const sheet = page.locator('[data-map-in-view-sheet]');
	if (await sheet.isVisible()) {
		await page.keyboard.press('Escape');
		await expect(sheet).toBeHidden();
	}
}
