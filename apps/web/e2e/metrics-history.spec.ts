import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { localizeHref } from '../src/lib/i18n/routing';
import { historyDepthCopy } from '../src/lib/features/metrics/historyDepth.copy';
import { copy as healthCopy } from '../src/lib/features/health/health.copy';

test.use({ bypassCSP: true });

// Controlled group coverage: intentionally wider family dates, distinct daily-only dates,
// declared gaps, and OC Transpo's unpublished crowding dates. No real-data depth claim.
function historyIndex(provider: string) {
	const inventory = {
		network: ['delay', 'delay_percentiles', 'vehicles', 'cancellation', 'occupancy'],
		lines: [
			'delay',
			'delay_percentiles',
			'cancellation',
			'occupancy',
			'service_span',
			'skipped_stops',
		],
		stops: ['delay', 'delay_percentiles', 'occupancy'],
	};
	return {
		generated_utc: '2026-11-11T07:11:00Z',
		methodology_version: 'history-1',
		publish_generation_id: `${provider}@2026-11-11T07:11:00Z`,
		families: Object.entries(inventory).map(([family, metrics]) => ({
			family,
			selection_mode: 'range',
			index_path: `historic/history/${family}/index.json`,
			first_available_date: '2026-05-01',
			last_available_date: '2026-11-10',
			gaps: [],
			metrics: metrics.map((metric) => ({
				metric,
				aggregation: ['delay_percentiles', 'vehicles', 'service_span'].includes(metric)
					? 'daily_only'
					: 'additive',
				first_available_date:
					metric === 'occupancy' && provider === 'octranspo'
						? null
						: metric === 'delay_percentiles'
							? '2026-10-29'
							: '2026-06-13',
				last_available_date:
					metric === 'occupancy' && provider === 'octranspo'
						? null
						: metric === 'service_span'
							? '2026-11-09'
							: '2026-11-10',
				...(metric === 'occupancy'
					? {}
					: {
							gaps:
								metric === 'delay_percentiles'
									? [
											{
												start_date: '2026-11-02',
												end_date: '2026-11-03',
												reason: 'controlled source outage',
											},
										]
									: [],
						}),
			})),
		})),
	};
}

for (const provider of ['stm', 'octranspo']) {
	for (const locale of ['en', 'fr'] as const) {
		for (const width of [320, 1280]) {
			test(`${provider} ${locale} ${width}: published history uses each metric group’s own evidence`, async ({
				page,
			}) => {
				const source = historyIndex(provider);
				const seen: string[] = [];
				await page.route('**/historic/history/index.json', async (route) => {
					seen.push(new URL(route.request().url()).pathname);
					await route.fulfill({ json: source });
				});
				await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
				await page.setViewportSize({ width, height: 900 });
				await page.goto(localizeHref('/metrics', locale, provider), { waitUntil: 'load' });
				await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
				const section = page.getByTestId('history-depth');
				const t = historyDepthCopy[locale];
				const labels = healthCopy[locale].historyCoverage;
				await expect(
					section.getByText(source.publish_generation_id, { exact: true }),
				).toBeVisible();
				await expect(section.getByText(t.intro, { exact: true })).toBeVisible();
				await expect(section.getByText(t.limits, { exact: true })).toBeVisible();
				await expect(section.locator('tbody tr')).toHaveCount(14);
				for (const family of source.families) {
					const dimension = section.locator(`[data-dimension="${family.family}"]`);
					for (const metric of family.metrics) {
						const row = dimension.locator(`[data-metric="${metric.metric}"]`);
						for (const [slot, value] of [
							['first', metric.first_available_date],
							['last', metric.last_available_date],
						]) {
							const cell = row.locator(`[data-date="${slot}"]`);
							if (value == null) {
								await expect(cell).toHaveText(t.unknown);
								await expect(cell.locator('time')).toHaveCount(0);
							} else await expect(cell.locator('time')).toHaveAttribute('datetime', value);
						}
						await expect(row.locator('[data-limit]')).toHaveText(
							metric.aggregation === 'daily_only'
								? labels.aggregation.daily_only
								: labels.aggregation.additive,
						);
						if (!metric.gaps) await expect(row.locator('[data-gaps]')).toHaveText(t.unknownGaps);
						else if (metric.gaps.length === 0)
							await expect(row.locator('[data-gaps]')).toHaveText(t.noGaps);
						else {
							await expect(row.locator('[data-gaps] time').nth(0)).toHaveAttribute(
								'datetime',
								'2026-11-02',
							);
							await expect(row.locator('[data-gaps] time').nth(1)).toHaveAttribute(
								'datetime',
								'2026-11-03',
							);
							await expect(row.locator('[data-gaps]')).toContainText('controlled source outage');
						}
					}
				}
				const scroll = section.getByRole('region').first();
				await scroll.focus();
				await expect(scroll).toBeFocused();
				await scroll.press('ArrowRight');
				if (width === 320)
					await expect
						.poll(() => scroll.evaluate((element) => element.scrollLeft))
						.toBeGreaterThan(0);
				expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
					width,
				);
				const details = section.getByRole('link', { name: t.details });
				await expect(details).toHaveAttribute('href', localizeHref('/status', locale, provider));
				expect((await details.boundingBox())!.height).toBeGreaterThanOrEqual(44);
				await details.focus();
				await expect(details).toBeFocused();
				expect(
					(await new AxeBuilder({ page }).include('[data-testid="history-depth"]').analyze())
						.violations,
				).toEqual([]);
				expect(seen).toEqual([`/v1/${provider}/historic/history/index.json`]);
			});
		}
	}
}
