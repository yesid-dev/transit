import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { localizeHref } from '../src/lib/i18n/routing';
import { historyDepthCopy } from '../src/lib/features/metrics/historyDepth.copy';

for (const locale of ['en', 'fr'] as const) {
	test(`${locale}: archived methodology links to the engine-backed coverage for the selected city`, async ({
		page,
	}) => {
		const city = 'octranspo';
		const snapshotRequests: string[] = [];
		page.on('request', (request) => {
			if (/\/(?:data\/)?v1\//.test(new URL(request.url()).pathname))
				snapshotRequests.push(request.url());
		});
		await page.goto(localizeHref('/metrics/archive', locale, city));
		await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
		const depth = page.locator('#history-depth');
		const link = depth.getByRole('link', { name: historyDepthCopy[locale].details });
		await expect(link).toHaveAttribute('href', localizeHref('/status', locale, city));
		await link.focus();
		await expect(link).toBeFocused();
		expect((await new AxeBuilder({ page }).include('#history-depth').analyze()).violations).toEqual(
			[],
		);
		await link.press('Enter');
		await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName(
			locale === 'fr' ? 'Santé des données' : 'Data health',
		);
		expect(snapshotRequests).toEqual([]);
	});
}
