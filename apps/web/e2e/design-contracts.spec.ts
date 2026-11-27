import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { expectAccessible } from '@yesid/config/playwright';
import { PUBLISHED_LOCALES } from '../src/lib/i18n/config';
import { localizeHref } from '../src/lib/i18n/routing';

const departures = JSON.parse(readFileSync(new URL('./departures.json', import.meta.url), 'utf8'));

test.use({ bypassCSP: true });
test.beforeEach(async ({ page }) => {
	await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
	await page.clock.setFixedTime(Date.parse(departures.generated_utc) + 30_000);
});

for (const locale of PUBLISHED_LOCALES) {
	for (const reducedMotion of ['reduce', 'no-preference'] as const) {
		test(
			locale +
				' Stop Record controls keep keyboard focus and fit at each width with ' +
				reducedMotion +
				' @theme',
			async ({ page }) => {
				await page.emulateMedia({ reducedMotion });
				for (const width of [390, 768, 1280, 1440]) {
					await page.setViewportSize({ width, height: 900 });
					await page.goto(
						localizeHref('/stop/S1?recordFrom=2026-11-08&recordTo=2026-11-14', locale, 'stm'),
					);
					const main = page.getByRole('main');
					const back = main.getByRole('link', {
						name: locale === 'fr' ? 'Tous les arrêts' : 'All stops',
					});
					const firstAction = main.getByRole('button', {
						name: locale === 'fr' ? 'Copier le lien' : 'Copy link',
					});
					await expect(firstAction).toBeVisible();
					await back.focus();
					await page.keyboard.press('Tab');
					await expect(firstAction).toBeFocused();
					for (const target of [back, firstAction]) {
						const bounds = (await target.boundingBox())!;
						expect(bounds.height).toBeGreaterThanOrEqual(44);
						expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
					}
					await expect(page.locator('html')).toHaveJSProperty('scrollWidth', width);
					await expectAccessible(page, { include: 'main' });
				}
			},
		);
	}

	test(`${locale} visible and hidden DetailFrame pills retain their navigation`, async ({
		page,
	}) => {
		await page.goto(localizeHref('/metrics/archive', locale));
		const pill = page.getByTestId('toc-pill').locator('button.toc-pill');
		if (page.viewportSize()!.width < 1024) {
			await expect(pill).toHaveAccessibleName(/Contents|Sommaire/);
			await expect(async () => {
				await pill.click();
				await expect(pill).toHaveAttribute('aria-expanded', 'true', { timeout: 1000 });
			}).toPass();
			await expect(page.locator('.toc-drawer-backdrop')).toHaveAccessibleName(
				locale === 'en' ? 'Close contents' : 'Fermer le sommaire',
			);
			await page.locator('.toc-drawer-item').first().click();
			await expect(pill).toHaveAttribute('aria-expanded', 'false');
		}
		// Keep the window that exposed the collision between the Network and Rankings fixtures.
		const dates = 'recordFrom=2026-11-20&recordTo=2026-11-26';
		for (const [path, surface] of [
			['/alerts?frameMode=live', '[data-slot="screen-content"]'],
			[`/rankings?${dates}`, '#ranking'],
			[`/network?${dates}`, '[data-slot="screen-content"]'],
			['/receipt?recordFrom=2026-11-26&recordTo=2026-11-26', 'article.daily-report'],
			[`/rankings?kind=departure&${dates}`, '#ranking'],
		]) {
			await page.goto(localizeHref(path, locale));
			await expect(page.locator(surface)).toBeVisible();
			await expect(page.getByTestId('toc-pill')).toHaveCount(0);
		}
	});
}

for (const input of ['desktop', 'touch-only', 'hybrid'] as const) {
	for (const reducedMotion of ['reduce', 'no-preference'] as const) {
		test(`${input} real wordmark and app frame view control policy with ${reducedMotion} @theme`, async ({
			browser,
			baseURL,
		}, testInfo) => {
			const context = await browser.newContext({
				baseURL,
				bypassCSP: true,
				viewport: { width: 1280, height: 900 },
				hasTouch: input === 'touch-only',
				isMobile: input === 'touch-only',
				reducedMotion,
				storageState: {
					cookies: [],
					origins: [
						{ origin: baseURL!, localStorage: [{ name: 'theme', value: testInfo.project.name }] },
					],
				},
			});
			try {
				if (input === 'hybrid')
					await context.addInitScript(() =>
						Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 }),
					);
				const page = await context.newPage();
				const clockTime = Date.parse('2026-11-22T12:00:00Z');
				await page.clock.install({ time: clockTime });
				await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
				await page.goto('/stop/S1?provider=stm&recordFrom=2026-11-08&recordTo=2026-11-14');
				await expect(
					page.getByRole('radiogroup', { name: 'View', exact: true }).first(),
				).toBeVisible();
				await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
				await page.clock.pauseAt(new Date(clockTime + 5_000));
				const capabilities = await page.evaluate(() => ({
					pointer: matchMedia('(any-hover: hover) and (any-pointer: fine)').matches,
					touch: navigator.maxTouchPoints,
				}));
				expect(capabilities.pointer).toBe(input !== 'touch-only');
				expect(capabilities.touch > 0).toBe(input !== 'desktop');
				const wordmarks = page.locator('[data-slot="wordmark-letters"]');
				expect(await wordmarks.count()).toBeGreaterThan(0);
				// yesid.design 0.44.0 ProductBrand: the header's house wordmark is still, like the footer's.
				expect(await page.locator('header [data-slot="wordmark-letters"]').count()).toBeGreaterThan(
					0,
				);
				await expect(page.locator('header [data-slot="wordmark-letters"] div')).toHaveCount(0);
				await expect(page.locator('footer [data-slot="wordmark-letters"] div')).toHaveCount(0);
				const segment = page
					.getByRole('radiogroup', { name: 'View', exact: true })
					.first()
					.getByRole('radio', { checked: true });
				await expect(segment).toHaveClass(/tap-press/);
				await segment.dispatchEvent('mouseenter');
				if (input === 'touch-only') {
					await expect(segment).not.toHaveAttribute('style', /scale\(1\.04\)/);
					await segment.dispatchEvent('pointerdown', { pointerType: 'touch' });
					await page.clock.runFor(150);
					await expect(segment).toHaveAttribute('style', /scale\(0\.94/);
					await segment.dispatchEvent('pointercancel', { pointerType: 'touch' });
				} else {
					await expect(segment).toHaveAttribute('style', /scale\(1\.04\)/);
					await segment.dispatchEvent('pointerdown', {
						pointerType: input === 'hybrid' ? 'touch' : 'mouse',
					});
					await page.clock.runFor(150);
					await expect(segment).toHaveAttribute('style', /scale\(1\.04\)/);
				}
				await page.clock.runFor(650);
				if (input !== 'touch-only')
					await expect(segment).not.toHaveAttribute('style', /transform:\s*scale/);
				await segment.focus();
				await expect(segment).toBeFocused();
			} finally {
				await context.close();
			}
		});
	}
}

for (const locale of PUBLISHED_LOCALES) {
	for (const reducedMotion of ['reduce', 'no-preference'] as const) {
		test(`${locale} real SurfaceRail touch, focus and ${reducedMotion} @theme`, async ({
			browser,
			baseURL,
		}, testInfo) => {
			const context = await browser.newContext({
				baseURL,
				bypassCSP: true,
				viewport: { width: 390, height: 844 },
				hasTouch: true,
				isMobile: true,
				reducedMotion,
				storageState: {
					cookies: [],
					origins: [
						{ origin: baseURL!, localStorage: [{ name: 'theme', value: testInfo.project.name }] },
					],
				},
			});
			try {
				const page = await context.newPage();
				await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
				await page.goto(localizeHref('/network?frameMode=live', locale));
				await expect(page.locator('html[data-hydrated]')).toHaveCount(1);
				const pill = page.locator('.surface-rail-pill:visible');
				await expect(pill).toHaveCount(1);
				const sheet = page.getByRole('dialog', {
					name: locale === 'fr' ? 'Options' : 'Controls',
					exact: true,
				});
				await pill.tap();
				await expect(sheet).toBeVisible();
				await expect(sheet.locator('[data-slot="surface-rail"]')).toBeVisible();
				await expect(sheet.locator('[data-slot="sheet-header"]')).toHaveCount(0);
				const motion = await sheet.evaluate((element) => {
					const style = getComputedStyle(element);
					return { animation: style.animationName, transition: style.transitionProperty };
				});
				if (reducedMotion === 'reduce') {
					expect(motion.animation).toBe('none');
					expect(motion.transition).toBe('none');
				} else expect(motion.animation).not.toBe('none');
				const segment = sheet.getByRole('radio', {
					name: locale === 'fr' ? 'En direct' : 'Live now',
					exact: true,
				});
				await segment.tap();
				await expect(segment).toHaveAttribute('aria-checked', 'true');
				await page.keyboard.press('Tab');
				expect(await sheet.evaluate((element) => element.contains(document.activeElement))).toBe(
					true,
				);
				if (reducedMotion === 'no-preference') {
					await expect.poll(() => sheet.evaluate((el) => el.getAnimations().length)).toBe(0);
					const samples = await sheet.evaluate(async (el) => {
						const heights: number[] = [];
						const rail = el.querySelector('[data-slot="surface-rail"]')!;
						const initialHeight = rail.getBoundingClientRect().height;
						el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
						await new Promise<void>((resolve) => {
							const sample = () => {
								if (!el.isConnected) return resolve();
								heights.push(el.contains(rail) ? rail.getBoundingClientRect().height : 0);
								requestAnimationFrame(sample);
							};
							requestAnimationFrame(sample);
						});
						return { heights, initialHeight };
					});
					expect(samples.heights.length).toBeGreaterThan(2);
					expect(Math.min(...samples.heights)).toBeGreaterThanOrEqual(samples.initialHeight - 1);
				} else {
					await page.keyboard.press('Escape');
				}
				await expect(sheet).toBeHidden();
				await expect(pill).toBeFocused();
			} finally {
				await context.close();
			}
		});
	}
}
