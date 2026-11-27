import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { installHealthCapture } from './capture-fixture';

const variants = [
	['stm', 'en', 1440, 'light'],
	['stm', 'fr', 1440, 'dark'],
	['octranspo', 'en', 390, 'light'],
	['stm', 'fr', 390, 'dark'],
] as const;

for (const [city, locale, width, theme] of process.env.TRANSIT_E2E_HEALTH_SCREENSHOTS
	? variants
	: [])
	test(`fixture pictures for ${city} in ${locale} at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
		await page.emulateMedia({ colorScheme: theme });
		await page.addInitScript((value) => localStorage.setItem('theme', value), theme);
		const refresh = city === 'stm' ? await installHealthCapture(page, { namedTrips: true }) : null;
		const prefix = locale === 'fr' ? '/fr' : '';
		for (const [route, folder] of [
			['network', 'pr20'],
			['status', 'pr21'],
		]) {
			for (const mode of ['record', 'live']) {
				const [from, to] =
					route === 'network' ? ['2026-11-20', '2026-11-22'] : ['2026-10-26', '2026-11-22'];
				await page.goto(
					`${prefix}/${route}?provider=${city}&frameMode=${mode}&recordFrom=${from}&recordTo=${to}`,
				);
				const main = page.getByRole('main');
				await expect(main.locator('[data-slot="record-card"]').first()).toBeVisible();
				await expect(main.locator('[data-record-pending]')).toHaveCount(0);
				if (mode === 'live' && refresh) {
					await refresh();
					await expect(main.locator('[data-slot="screen-answer"]')).toContainText(
						route === 'network' ? '364' : locale === 'fr' ? 'Avis de service' : 'Service alerts',
					);
					if (route === 'network') {
						const table = main.getByRole('table');
						await expect(table.getByRole('link')).toHaveCount(8);
						await expect(table.getByText('Station Place-des-Arts')).toBeVisible();
						await expect(
							table.getByText(locale === 'fr' ? 'Inconnu' : 'Unknown', { exact: true }),
						).toHaveCount(0);
					}
				}
				const axe = await new AxeBuilder({ page })
					.include('main')
					.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
					.analyze();
				expect(
					axe.violations.map(({ id, nodes }) => [id, nodes.map(({ target }) => target)]),
				).toEqual([]);
				await page.evaluate(() => document.fonts.ready);
				await page.screenshot({
					fullPage: true,
					path: `test-results/health-evidence/${folder}/${city}-${locale}-${mode}-${width}-${theme}.png`,
				});
			}
		}
		if (city === 'stm' && locale === 'en' && width === 1440) {
			for (const [route, folder] of [
				['network', 'pr20'],
				['status', 'pr21'],
			]) {
				await page.goto(
					`/${route}?provider=stm&frameMode=record&recordFrom=2026-11-05&recordTo=2026-11-11`,
				);
				await expect(
					page.getByText('The record is temporarily unavailable.').first(),
				).toBeVisible();
				await page.screenshot({
					fullPage: true,
					path: `test-results/health-evidence/${folder}/stm-en-record-engine-unreachable.png`,
				});
			}
		}
	});
