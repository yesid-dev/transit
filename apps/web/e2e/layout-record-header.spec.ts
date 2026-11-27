import { expect, type Page } from '@playwright/test';
import { streamingLayoutTest as test } from './layout-test';
import { localizeHref } from '../src/lib/i18n/routing';
import { waitForFrameClearance } from './layout-helpers';

const pages = [
	{ name: 'line', path: '/lines/24', section: 'stops' },
	{ name: 'stop', path: '/stop/S1', section: 'byLine' },
] as const;

function frame(page: Page) {
	return page.locator('main h1').evaluate((heading) => ({
		header: heading.closest('header')!.getBoundingClientRect().height,
		first: document.querySelector('#punctuality')!.getBoundingClientRect().top + window.scrollY,
	}));
}

for (const { name, path, section } of pages)
	for (const locale of ['en', 'fr'] as const)
		for (const width of [320, 360, 390, 768, 1440])
			for (const scale of [100, 200])
				test(
					locale +
						' ' +
						name +
						' header clears the chrome and stays still while a cut streams at ' +
						width +
						'px and ' +
						scale +
						'% text',
					async ({ page, request, browserName, colorScheme }) => {
						const city = locale === 'fr' ? 'octranspo' : 'stm';
						const variant = (browserName === 'webkit' ? 2 : 0) + (colorScheme === 'dark' ? 1 : 0);
						const start = '2026-10-' + String(15 + variant);
						const end =
							'2026-11-' +
							String(10 + [320, 360, 390, 768, 1440].indexOf(width) * 2 + (scale === 200 ? 1 : 0));
						const fixture = [name, city, start, end].join('-');
						const port = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';
						const releaseCut = () =>
							request.post('http://127.0.0.1:' + port + '/__overview/release?fixture=' + fixture);
						let releaseScripts!: () => void;
						const scripts = new Promise<void>((resolve) => (releaseScripts = resolve));
						await page.route('**/_app/immutable/**/*.js', async (route) => {
							await scripts;
							await route.fallback();
						});
						const reading = page.locator('#punctuality');
						const cut = page.locator('#' + section);
						try {
							await page.setViewportSize({ width, height: 900 });
							await page.goto(
								localizeHref(path, locale, city) + '&recordFrom=' + start + '&recordTo=' + end,
								{ waitUntil: 'commit' },
							);
							await page.addStyleTag({ content: 'html { font-size: ' + scale + '%; }' });
							await expect(reading).toBeVisible();
							await expect(page.locator('html[data-hydrated]')).toHaveCount(0);
							if (name === 'line') {
								for (const id of [
									'daily',
									'hourly',
									'stops',
									'delivery',
									'late',
									'waiting',
									'offered',
									'crowding',
									'schedule',
									'alerts',
								]) {
									await expect(page.locator('main #' + id + ' h2').first()).toBeAttached();
								}
							}
							await expect
								.poll(() =>
									page.locator('main h1').evaluate((heading) => {
										const stylesheets =
											document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]');
										if ([...stylesheets].some((link) => !link.disabled && !link.sheet))
											return false;
										// Resolve the styled layout before checking its font requests.
										heading.getBoundingClientRect();
										return [...document.fonts].every((font) => font.status !== 'loading');
									}),
								)
								.toBe(true);
							const before = await frame(page);
							const gap = await page
								.locator('[data-slot="app-frame-header"]')
								.evaluate((element) => {
									const heading = document.querySelector('main h1')!;
									return (
										heading.getBoundingClientRect().top - element.getBoundingClientRect().bottom
									);
								});
							expect(gap).toBeGreaterThanOrEqual(0);
							releaseScripts();
							if (name === 'stop')
								await expect(page.locator('#stop-bands-chart').getByRole('img')).toBeVisible();
							else {
								await expect(reading.locator('[data-slot="answer-lead"]')).toBeVisible();
								if (width === 1440 && scale === 100) {
									const geometry = await reading
										.locator('[data-slot="record-answer"]')
										.evaluate((answer) => {
											const box = (selector: string) =>
												answer.querySelector(selector)!.getBoundingClientRect();
											const stamp = box('.answer-stamp');
											const actions = box('.answer-actions');
											const evidence = box('[data-slot="answer-evidence"]');
											return {
												separateEvidence: evidence.top >= stamp.bottom,
												actionsBesideStamp:
													actions.top < stamp.bottom && actions.bottom > stamp.top,
											};
										});
									expect(geometry).toEqual({ separateEvidence: true, actionsBesideStamp: true });
								}
							}
							const cutContent =
								name === 'stop' ? cut.getByRole('table') : cut.locator('[data-slot="stop-ladder"]');
							await expect(cutContent).toHaveCount(0);
							expect(await frame(page)).toEqual(before);
							expect((await releaseCut()).status()).toBe(204);
							if (name === 'line' && width < 640) await cut.getByRole('button').first().click();
							await expect(cutContent.first()).toBeVisible();
							await waitForFrameClearance(page);
							expect(await frame(page)).toEqual(before);
						} finally {
							releaseScripts();
							await releaseCut();
						}
					},
				);
