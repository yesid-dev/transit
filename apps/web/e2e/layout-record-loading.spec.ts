import { expect } from '@playwright/test';
import { test } from './layout-test';
import { localizeHref } from '../src/lib/i18n/routing';
import { waitForFrameClearance } from './layout-helpers';

for (const locale of ['en', 'fr'] as const)
	test(
		locale + ' Daily report keeps its header and first reading still while messages stream',
		async ({ page, request }) => {
			const city = locale === 'fr' ? 'octranspo' : 'stm';
			const port = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';
			const releaseMessages = () =>
				request.post(
					'http://127.0.0.1:' + port + '/__overview/release?fixture=daily-layout-' + city,
				);
			const first = page.locator('#punctuality');
			const message = page.locator('#messages');
			const frame = () =>
				page.locator('main h1').evaluate((heading) => ({
					header: heading.getBoundingClientRect().top,
					first: document.querySelector('#punctuality')!.getBoundingClientRect().top,
				}));
			try {
				for (const width of [320, 390, 768, 1280]) {
					await page.setViewportSize({ width, height: 900 });
					await page.goto(
						localizeHref('/receipt', locale, city) + '&recordFrom=2026-11-18&recordTo=2026-11-18',
						{ waitUntil: 'commit' },
					);
					await expect(first.getByText(/80\s?%/u).first()).toBeVisible();
					await page.evaluate(() => document.fonts.ready);
					await expect(message.getByRole('link', { name: /CSV/u })).toHaveCount(0);
					const before = await frame();
					expect((await releaseMessages()).status()).toBe(204);
					await expect(message.getByRole('link', { name: /CSV/u })).toBeVisible();
					await waitForFrameClearance(page);
					expect(await frame(), width + 'px').toEqual(before);
				}
			} finally {
				await releaseMessages();
			}
		},
	);
