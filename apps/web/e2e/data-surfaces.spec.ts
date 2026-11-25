import { openFrameControls } from './frame-controls';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

import { PUBLISHED_LOCALES } from '../src/lib/i18n/config';
import { localizeHref } from '../src/lib/i18n/routing';
import { stampCopy } from '../src/lib/v1/stamp.copy';
import { captureUrl, layoutCapture } from './capture-fixture';

const fixture = (name: string) =>
	JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'));
const departures = fixture('departures.json');
const stop = Object.keys(departures.stops)[0]!;
// Inside the live data's 30 s freshness window.
const now = Date.parse(departures.generated_utc) + 30_000;

for (const lang of PUBLISHED_LOCALES)
	test(lang + ': live pages show only the live and record stamp forms', async ({ page }) => {
		const manifest = fixture('manifest.json');
		const line = fixture('routes-index.json').routes[0].id;
		const stopName = fixture('stops-index.json').stops[0].name;
		const patterns = (['data', 'alerts'] as const).flatMap((subject) =>
			(['current', 'behind', 'unknown', 'not-responding'] as const).map((state) =>
				stampCopy[lang].live(subject, state, '\0').split('\0').join('.+'),
			),
		);
		const pattern = new RegExp('^(?:' + patterns.join('|') + ')$');
		let liveCount = 0;
		for (const path of [
			'/',
			'/map',
			'/network',
			'/lines/' + line + '?tab=detail',
			'/stop/' + stop + '?tab=detail',
			'/search?q=' + encodeURIComponent(stopName),
		]) {
			await page.goto(localizeHref(path, lang, manifest.provider));
			await page.waitForLoadState('networkidle');
			const stamps = page.locator('[data-slot="freshness-stamp"]');
			for (const stamp of await stamps.all()) {
				await expect(stamp).toHaveAttribute('data-form', /^(live|record)$/);
				if ((await stamp.getAttribute('data-form')) === 'live') {
					await expect(stamp.locator('time')).not.toHaveCSS('white-space', 'nowrap');
					if (path === '/map') {
						// The kit chip has a decorative mark before its time label.
						await expect
							.poll(async () => (await stamp.locator('time').innerText()).trim())
							.toMatch(pattern);
					} else {
						await expect(stamp.locator('time')).toHaveText(pattern);
					}
					liveCount++;
				}
			}
			if (path === '/network') await expect(page.locator('[data-slot="feed-age"]')).toHaveCount(0);
			if (path === '/network')
				await expect(page.locator('[data-slot="article-keywords"]')).toHaveCount(0);
		}
		expect(liveCount).toBeGreaterThan(0);
	});

test.use({ bypassCSP: true });

test.beforeEach(async ({ page }) => {
	await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
	await page.route(captureUrl, (route) =>
		route.fulfill({
			json: layoutCapture(new URL(route.request().url()).searchParams.get('city')!),
		}),
	);
	await page.clock.setFixedTime(now);
});

for (const lang of PUBLISHED_LOCALES)
	test(lang + ': Stop Record and Live share the selected city and dates', async ({ page }) => {
		await page.clock.setFixedTime(Date.parse('2026-11-23T16:00:00Z'));
		const path = localizeHref('/stop/S1', lang, 'stm');
		await page.goto(path + '&recordFrom=2026-11-08&recordTo=2026-11-14');
		const views = await openFrameControls(page, lang);
		const recordName = lang === 'fr' ? 'Bilan' : 'Record';
		const liveName = lang === 'fr' ? 'En direct' : 'Live now';
		await expect(views.getByRole('radio', { name: recordName, exact: true })).toBeChecked();
		await views.getByRole('radio', { name: liveName, exact: true }).click();
		await expect(page).toHaveURL(
			(url) =>
				url.searchParams.get('provider') === 'stm' &&
				url.searchParams.get('recordFrom') === '2026-11-08' &&
				url.searchParams.get('recordTo') === '2026-11-14' &&
				url.searchParams.get('frameMode') === 'live',
		);
		await page.goBack();
		await expect(
			(await openFrameControls(page, lang)).getByRole('radio', { name: recordName, exact: true }),
		).toBeChecked();
	});
