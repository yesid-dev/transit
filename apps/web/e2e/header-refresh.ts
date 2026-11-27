import { expect, type Page } from '@playwright/test';
import { navPillCopy } from '../src/lib/i18n/messages';
import type { Locale } from '../src/lib/i18n/config';

export async function revealRefresh(page: Page, locale: Locale = 'en') {
	const refresh = page.getByRole('main').getByRole('button', {
		name: navPillCopy[locale].refresh,
	});
	await expect(refresh).toBeVisible();
	return refresh;
}
