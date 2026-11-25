import { test } from './layout-input-test';
import { expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const read = (name: string) =>
	JSON.parse(readFileSync(new URL('./' + name + '.json', import.meta.url), 'utf8'));
const epoch = Date.parse(read('departures').generated_utc);
const line = read('routes-index').routes[0].id;
const stop = Object.keys(read('departures').stops)[0];
const shots = fileURLToPath(new URL('../../../.cache/cohesion/after/', import.meta.url));
mkdirSync(shots, { recursive: true });
const recordClearance = (page: Page) =>
	page.evaluate(() => {
		const controls = document.querySelector('[data-slot="app-frame-header"]')!;
		const title = document.querySelector('main h1')!;
		return controls.getBoundingClientRect().bottom <= title.getBoundingClientRect().top;
	});
for (const provider of ['stm', 'octranspo'])
	for (const locale of ['en', 'fr'])
		test(`${provider} ${locale} 390 frame controls clear the Line Record heading @layout`, async ({
			page,
		}) => {
			const path = (locale === 'fr' ? '/fr' : '') + '/lines/' + line + '?provider=' + provider;
			await page.setViewportSize({ width: 390, height: 844 });
			await page.clock.setFixedTime(epoch + 30000);
			await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
			// First paint: the server markup, measured while the app's scripts are held back. One
			// navigation: WebKit keeps a failed module import, so an aborted load cannot be retried.
			let release = () => {};
			const held = new Promise<void>((resolve) => (release = () => resolve()));
			await page.route('**/_app/immutable/**/*.js', (route) => held.then(() => route.fallback()));
			await page.goto(path, { waitUntil: 'domcontentloaded' });
			const hydratedEarly = await page.locator('html').getAttribute('data-hydrated');
			const atFirstPaint = await recordClearance(page);
			release();
			expect([hydratedEarly, atFirstPaint]).toEqual([null, true]);
			await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
			expect(await recordClearance(page)).toBe(true);
		});
for (const provider of ['stm', 'octranspo'])
	for (const locale of ['en', 'fr'])
		for (const width of [390, 1440]) {
			test(
				provider + ' ' + locale + ' ' + width + ' detail page controls @layout',
				async ({ page }, info) => {
					await page.setViewportSize({ width, height: 900 });
					await page.clock.setFixedTime(epoch + 30000);
					await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
					await page.route('**/v1/**', async (route) => {
						const url = new URL(route.request().url());
						url.pathname = '/__layout/fresh' + url.pathname;
						await route.fulfill({ response: await route.fetch({ url: url.href }) });
					});
					for (const [kind, path] of [
						['line', '/lines/' + line],
						['stop', '/stop/' + stop],
					]) {
						await page.goto((locale === 'fr' ? '/fr' : '') + path + '?provider=' + provider, {
							waitUntil: 'networkidle',
						});
						await expect(page.getByRole('main')).toBeVisible();
						await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
						if (kind === 'line') {
							const main = page.getByRole('main');
							await expect(
								main.getByRole('navigation', { name: /Line views|Vues de la ligne/ }),
							).toHaveCount(0);
							const first = main.getByRole('link', { name: /^(All lines|Toutes les lignes)$/ });
							await first.focus();
							await expect(first).toBeFocused();
							await page.keyboard.press('Tab');
							await expect(
								main.getByRole('button', { name: /^(Copy link|Copier le lien)$/ }),
							).toBeFocused();
							expect(
								(await new AxeBuilder({ page }).include('[data-slot="screen-answer"]').analyze())
									.violations,
							).toEqual([]);
						}
						await page.screenshot({
							animations: 'disabled',
							path:
								shots +
								'/' +
								provider +
								'-' +
								locale +
								'-' +
								width +
								'-' +
								kind +
								'-page-' +
								info.project.name +
								'.png',
						});
					}
				},
			);
		}
