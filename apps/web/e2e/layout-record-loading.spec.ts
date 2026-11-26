import { expect } from '@playwright/test';
import { streamingLayoutTest as test } from './layout-test';
import { localizeHref } from '../src/lib/i18n/routing';
import { waitForFrameClearance } from './layout-helpers';
import { dailyMessageHold } from './daily-message-hold';

for (const locale of ['en', 'fr'] as const)
	test(
		locale + ' Daily report keeps its header and first reading still while messages stream',
		async ({ page, request, browserName, colorScheme }) => {
			const city = 'stm';
			const variant = (browserName === 'webkit' ? 2 : 0) + (colorScheme === 'dark' ? 1 : 0);
			const end = '2026-11-' + [18, 19, 21, 22][variant];
			const hold = dailyMessageHold(request);
			const first = page.locator('#punctuality');
			const message = page.locator('#messages');
			const frame = () =>
				page.locator('main h1').evaluate((heading) => ({
					header: heading.getBoundingClientRect().top,
					first: document.querySelector('#punctuality')!.getBoundingClientRect().top,
				}));
			try {
				await page.setExtraHTTPHeaders(hold.headers);
				for (const width of [320, 390, 768, 1280]) {
					expect((await hold.start()).status()).toBe(204);
					await page.setViewportSize({ width, height: 900 });
					await page.goto(
						localizeHref('/receipt', locale, city) + '&recordFrom=2026-11-18&recordTo=' + end,
						{ waitUntil: 'commit' },
					);
					await expect(first.getByText(/80[.,]0\s?%/u).first()).toBeVisible();
					await expect
						.poll(() =>
							page.evaluate(() => [...document.fonts].some((font) => font.status === 'loading')),
						)
						.toBe(false);
					await expect(
						message.getByText(
							locale === 'fr'
								? 'Non suivi\u00a0: Transit n’a pas collecté les avis de la STM à ces dates.'
								: 'Not tracked: Transit did not collect STM’s alerts on these dates.',
						),
					).toHaveCount(0);
					const before = await frame();
					if (width === 1280) {
						await expect(page.locator('[data-testid="nav-pill"].nav-hydrated')).toBeVisible();
						const menu = page.getByTestId('nav-menu-toggle');
						await menu.click();
						await expect(menu).toHaveAttribute('aria-expanded', 'true');
						await page.keyboard.press('Escape');
						await expect(menu).toHaveAttribute('aria-expanded', 'false');
						await expect(menu).toBeFocused();
					}
					expect((await hold.release()).status()).toBe(204);
					await expect(
						message.getByText(
							locale === 'fr'
								? 'Non suivi\u00a0: Transit n’a pas collecté les avis de la STM à ces dates.'
								: 'Not tracked: Transit did not collect STM’s alerts on these dates.',
						),
					).toBeVisible();
					await waitForFrameClearance(page);
					expect(await frame(), width + 'px').toEqual(before);
				}
			} finally {
				await hold.release();
			}
		},
	);
