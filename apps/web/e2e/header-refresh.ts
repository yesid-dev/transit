import { expect, type Page } from '@playwright/test';
import { navPillCopy } from '../src/lib/i18n/messages';
import type { Locale } from '../src/lib/i18n/config';

/** On phones Refresh lives in the open menu; wider headers expose it directly. */
export async function revealRefresh(page: Page, locale: Locale = 'en') {
	const copy = navPillCopy[locale];
	const refresh = page.getByRole('button', { name: copy.refresh, exact: true });
	if (!(await refresh.isVisible())) {
		await page.getByRole('button', { name: copy.openMenu, exact: true }).click();
		await expect(page.getByRole('dialog', { name: copy.menu })).toBeVisible();
	}
	await expect(refresh).toBeVisible();
	return refresh;
}
