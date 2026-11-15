import { expect, type Page } from '@playwright/test';
import { navPillCopy } from '../src/lib/i18n/messages';
import type { Locale } from '../src/lib/i18n/config';

/** A phone-width header offers Refresh only in its open menu; wider headers keep it in the pill. */
export async function revealRefresh(page: Page, locale: Locale): Promise<void> {
	await page.waitForLoadState('networkidle');
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
	const refresh = page
		.getByTestId('nav-pill')
		.getByRole('button', { name: navPillCopy[locale].refresh, exact: true });
	if (await refresh.isVisible()) return;
	await page.getByRole('button', { name: navPillCopy[locale].openMenu }).click();
	await expect(page.getByRole('dialog', { name: navPillCopy[locale].menu })).toBeVisible();
	await expect(refresh).toBeVisible();
}
