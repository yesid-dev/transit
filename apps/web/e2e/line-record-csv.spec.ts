import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator } from '@playwright/test';
import { localizeHref } from '../src/lib/i18n/routing';
import { reliabilityCopy } from '../src/lib/features/lines/reliability/reliability.copy';
import { csvTable } from '../src/lib/features/lines/reliability/__fixtures__/csvTable';

test.use({ bypassCSP: true });
test.describe.configure({ mode: 'parallel' });
test.beforeEach(async ({ page }) => {
	await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
});

for (const provider of ['stm', 'octranspo'])
	for (const locale of ['en', 'fr'] as const)
		for (const width of [320, 390, 768, 1280])
			test(`${provider} ${locale} ${width}: displayed CSV bytes, attribution and controls`, async ({
				page,
				request,
				baseURL,
			}) => {
				const dataPort = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';
				const dataOrigin = `http://127.0.0.1:${dataPort}`;
				const manifest = await (
					await request.get(`${dataOrigin}/v1/${provider}/manifest.json`)
				).json();
				const source = await (
					await request.get(`${dataOrigin}/v1/${provider}/historic/route_reliability/9002.json`)
				).json();
				let sourceRequests = 0;
				page.on('request', (req) => {
					if (/\/historic\//u.test(req.url())) sourceRequests++;
				});
				const file = (block: string) => page.locator(`a[download*="-${block}-"]`);
				async function download(link: Locator) {
					const descriptor = await link.getAttribute('href');
					const href = page.url();
					const before = sourceRequests;
					await link.focus();
					await expect(link).toBeFocused();
					const pending = page.waitForEvent('download');
					await link.press('Enter');
					const result = await pending;
					const bytes = readFileSync((await result.path())!, 'utf8');
					expect(bytes).toBe(decodeURIComponent(descriptor!.slice(descriptor!.indexOf(',') + 1)));
					expect(result.suggestedFilename()).toMatch(/-displayed-rows\.csv$/u);
					expect(page.url()).toBe(href);
					expect(sourceRequests).toBe(before);
					return csvTable(bytes);
				}
				await page.setViewportSize({ width, height: 1000 });
				await page.goto(localizeHref('/lines/9002', locale, provider), {
					waitUntil: 'domcontentloaded',
				});
				await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
				await expect(file('record')).toBeVisible();
				const record = (await download(file('record')))[0];
				expect(record).toMatchObject({
					provider,
					locale,
					line_id: '9002',
					source: 'current_line_file',
					attribution: manifest.attribution,
					publication_generated_utc: source.generated_utc,
					publication_generation_id: source.publish_generation_id ?? '',
					publication_methodology_version: source.methodology_version ?? '',
				});
				const url = new URL(record.record_url);
				expect(url.origin).toBe(new URL(baseURL!).origin);
				expect(url.pathname).toBe(locale === 'fr' ? '/fr/lines/9002' : '/lines/9002');
				expect(url.searchParams.get('provider')).toBe(provider);
				const days = source.periods.slice(-7);
				const publishedRecord = source.periods_by_grain.find(
					(r: { grain: string }) => r.grain === 'week',
				).by_daytype;
				const readings = publishedRecord.reduce(
					(s: number, d: { observation_count: number }) => s + d.observation_count,
					0,
				);
				const onTime = publishedRecord.reduce(
					(s: number, d: { on_time: number }) => s + d.on_time,
					0,
				);
				expect(record.on_time_pct).toBe(
					String(Math.floor((200 * onTime + readings) / (2 * readings))),
				);
				expect(record.readings).toBe(String(readings));
				await expect(page.locator('[data-slot="record-figure"]')).toContainText(record.on_time_pct);
				const daily = await download(file('day-by-day'));
				expect(daily.map((r) => r.date)).toEqual(days.map((d: { date: string }) => d.date));
				const stops = page.locator('[data-slot="stop-delays"]');
				const stopCsv = file('stop-delays');
				const firstFive = await download(stopCsv);
				expect(firstFive).toHaveLength(5);
				const names = await stops
					.locator('[data-slot="stop-delay-row"] .stop-row__name')
					.allTextContents();
				expect(firstFive.map((r) => r.stop_name)).toEqual(names);
				const toggle = stops.locator('[data-slot="stop-delays-toggle"]');
				await toggle.click();
				const all = await download(stopCsv);
				expect(all).toHaveLength(15);
				expect(all.map((r) => r.stop_name)).toEqual(
					await stops.locator('.stop-row__name').allTextContents(),
				);
				const cut = source.weak_stops_by_grain.find((r: { grain: string }) => r.grain === 'week');
				for (const row of all) {
					const expected = cut.stops.find((s: { id: string }) => s.id === row.stop_id);
					expect(row.late_share_pct).toBe(String(Math.round(expected.severe_pct * 10) / 10));
					expect(row.readings).toBe(String(expected.observation_count));
				}
				await expect(toggle).toHaveAttribute('aria-expanded', 'true');
				await toggle.click();
				expect(await download(stopCsv)).toHaveLength(5);
				for (const band of ['verdict', 'when-to-ride', 'the-wait', 'crowding']) {
					const button = page.locator(`[data-band="${band}"]`).getByRole('button', {
						name: reliabilityCopy[locale].sections.detailShow,
						exact: true,
					});
					if (await button.count()) await button.click();
				}
				for (const link of await page.locator('[data-slot="record-csv"]').all()) {
					const box = await link.boundingBox();
					if (!box) continue;
					expect(box.height).toBeGreaterThanOrEqual(44);
					expect(box.x).toBeGreaterThanOrEqual(0);
					expect(box.x + box.width).toBeLessThanOrEqual(width);
					await expect(link).toHaveAccessibleName(/CSV.+:/u);
				}
				const crowds = await download(file('crowding-mix'));
				expect(
					crowds.every(
						(r) =>
							r.scope === 'undated_week_mix' &&
							r.window_from === '' &&
							r.window_to === '' &&
							r.readings === '',
					),
				).toBe(true);
				const relative = await download(file('relative-pattern'));
				expect(relative).toHaveLength(7 * 24);
				expect(
					relative.every(
						(r) => r.scope === 'history' && r.unit === 'row_relative_score' && r.window_from === '',
					),
				).toBe(true);
				const trip = await download(file('trip-facts'));
				expect(trip.find((r) => r.measure === 'missing_trips')).toMatchObject({
					state: 'not_published',
					numerator: '',
					denominator: '',
					value_pct: '',
				});
				expect(trip.find((r) => r.measure === 'silent_trips')).toMatchObject({
					state: 'live_only',
					numerator: '',
					value_pct: '',
				});
				if (width === 390)
					expect(
						(await new AxeBuilder({ page }).include('[data-slot="reliability-clusters"]').analyze())
							.violations,
					).toEqual([]);
				const mobileControls = page.getByRole('button', {
					name: reliabilityCopy[locale].controls.filterPillOpen,
				});
				const inSheet = await mobileControls.isVisible();
				if (inSheet) {
					await mobileControls.focus();
					await mobileControls.press('Enter');
				}
				await page
					.getByRole('radio', { name: reliabilityCopy[locale].controls.latestDay, exact: true })
					.first()
					.click();
				if (inSheet) await page.keyboard.press('Escape');
				await expect(file('crowding-mix')).toHaveAttribute('download', /undated_day_mix/u);
				const dayMix = await download(file('crowding-mix'));
				expect(
					dayMix.every(
						(row) =>
							row.scope === 'undated_day_mix' &&
							new URL(row.record_url).searchParams.get('grain') === 'day' &&
							row.window_from === '',
					),
				).toBe(true);
				expect(await download(file('day-by-day'))).toHaveLength(14);
			});
