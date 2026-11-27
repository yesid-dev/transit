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
				const carrier = page.locator('[data-slot="surface-rail-mobile"]');
				const pill = carrier.locator(':scope > button');
				const rail = carrier.locator('aside[data-slot="surface-rail"]');
				const dialog = carrier.getByRole('dialog', {
					name: locale === 'fr' ? 'Options' : 'Controls',
					exact: true,
				});
				await expect(pill).toBeVisible();
				await expect(rail).toBeHidden();
				await expect(dialog).toHaveCount(0);
				await pill.tap();
				await expect(dialog).toBeVisible();
				await expect(rail).toHaveRole('dialog');
				await expect(rail).toHaveAttribute('aria-modal', 'true');
				await expect(rail.locator('[data-slot="sheet-header"]')).toHaveCount(0);
				const segment = dialog.getByRole('radio', {
					name: locale === 'fr' ? 'En direct' : 'Live now',
					exact: true,
				});
				await segment.tap();
				await expect(segment).toHaveAttribute('aria-checked', 'true');
				await page.keyboard.press('Tab');
				expect(await rail.evaluate((element) => element.contains(document.activeElement))).toBe(
					true,
				);

				await expect.poll(() => rail.evaluate((el) => el.getAnimations().length)).toBe(0);
				const motion = await rail.evaluate(async (el: HTMLElement) => {
					const carrier = el.closest('[data-slot="surface-rail-mobile"]')!;
					const initialHeight = el.offsetHeight;
					const heights: number[] = [];
					const transitions = new Set<string>();
					let animations = 0;
					el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
					await new Promise<void>((resolve) => {
						const sample = () => {
							for (const animation of el.getAnimations()) {
								if (animation instanceof CSSTransition)
									transitions.add(animation.transitionProperty);
								else animations++;
							}
							if (carrier.getAttribute('data-present') === 'false') return resolve();
							heights.push(el.offsetHeight);
							requestAnimationFrame(sample);
						};
						requestAnimationFrame(sample);
					});
					return { heights, initialHeight, transitions: [...transitions], animations };
				});
				expect(motion.animations).toBe(0);
				if (reducedMotion === 'reduce') {
					expect(motion.transitions).toEqual([]);
				} else {
					expect(motion.transitions).toEqual(expect.arrayContaining(['opacity', 'transform']));
					expect(motion.heights.length).toBeGreaterThan(0);
					expect(Math.min(...motion.heights)).toBeGreaterThanOrEqual(motion.initialHeight - 1);
				}
				await expect(carrier).toHaveAttribute('data-present', 'false');
				await expect(rail).toHaveCount(1);
				await expect(rail).toHaveAttribute('inert', '');
				await expect(rail).toBeHidden();
				await expect(dialog).toHaveCount(0);
				await expect(pill).toBeFocused();
			} finally {
				await context.close();
			}
		});
	}
}

for (const locale of PUBLISHED_LOCALES) {
	test(`${locale} SurfaceRail keeps its full pill label when space is tight @theme`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 320, height: 844 });
		await page.goto(localizeHref('/network?frameMode=live', locale));
		await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
		await page.evaluate(() => document.fonts.ready);
		const pill = page.locator('[data-slot="surface-rail-mobile"] > button');
		const label = pill.locator('.surface-rail-pill-label');
		const summary = pill.locator('.surface-rail-pill-summary-text');
		await expect(summary).toBeVisible();
		await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
		await expect(pill).toBeVisible();
		await expect(summary).toHaveCount(1);
		expect(await label.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
		expect(await pill.evaluate((el) => el.getBoundingClientRect().right)).toBeLessThanOrEqual(320);
	});
}
