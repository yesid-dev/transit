import { expect, test } from '@playwright/test';

import { PUBLISHED_LOCALES } from '../src/lib/i18n/config';
import { localizeHref } from '../src/lib/i18n/routing';
import {
	captureFixture,
	captureTrip,
	captureTripReport,
	captureUrl,
	captureVehicle,
} from './capture-fixture';

const provider = 'stm';

test.use({ bypassCSP: true });

test.beforeEach(async ({ page }) => {
	await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
});

for (const locale of PUBLISHED_LOCALES) {
	test(locale + ': old Line Schedule addresses preserve the record selection', async ({ page }) => {
		await page.goto(
			localizeHref(
				'/lines/24?tab=schedule&direction=1&dayType=saturday&recordFrom=2026-11-08&recordTo=2026-11-14',
				locale,
				provider,
			),
		);
		await expect(page).toHaveURL(
			(url) =>
				url.hash === '#schedule' &&
				url.searchParams.get('dayType') === 'saturday' &&
				url.searchParams.get('direction') === '1' &&
				url.searchParams.get('recordFrom') === '2026-11-08' &&
				url.searchParams.get('recordTo') === '2026-11-14',
		);
		await expect(
			page
				.locator('#schedule')
				.getByRole('radio', { name: locale === 'fr' ? 'Samedi' : 'Saturday' }),
		).toBeChecked();
	});
}
for (const locale of PUBLISHED_LOCALES) {
	test(`${locale}: Line Live shows a paged roster, predictions, and the same title as Record`, async ({
		page,
	}) => {
		const fr = locale === 'fr';
		const legacyRequests: string[] = [];
		page.on('request', (request) => {
			const url = new URL(request.url());
			if (url.pathname.startsWith('/v1/')) legacyRequests.push(url.pathname);
		});
		await page.clock.install();
		await page.route(captureUrl, async (route) => {
			const at = await page.evaluate(() => Date.now());
			const vehicles = Array.from({ length: 21 }, (_, index) =>
				captureVehicle(at - 18_000, {
					vehicle_id: `40-${298 + index}`,
					route_id: '9003',
					trip_id: `trip-${index}`,
					delay: [-72, -60, 300, 390, null][index % 5],
					stop_id: `t4-${index % 5}`,
				}),
			);
			await route.fulfill({
				json: captureFixture(at, {
					vehicle_positions: vehicles,
					non_responding_by_route: [{ route_id: '9003', count: 2 }],
				}),
			});
		});
		await page.route('**/api/live-trips?city=stm&line=9003', async (route) => {
			const at = await page.evaluate(() => Date.now());
			await route.fulfill({
				json: captureTripReport('stm', new Date(at).toISOString(), [
					captureTrip('trip-0', '9003', [
						{ stop: 't4-0', eta_utc: new Date(at + 270_000).toISOString(), delay_min: 2 },
					]),
				]),
			});
		});
		const href = localizeHref('/lines/9003?tab=detail', locale, provider);
		const document = await page.goto(href);
		expect(document?.headers()['cache-control']).toContain('no-store');
		await expect(page).toHaveURL(
			(url) => url.searchParams.get('frameMode') === 'live' && !url.searchParams.has('tab'),
		);
		await expect(
			page.locator('[data-slot="article-header"], [data-slot="detail-shell"]'),
		).toHaveCount(0);
		const heading = await page.getByRole('heading', { level: 1 }).innerText();
		await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
		const refresh = page.waitForResponse((response) => captureUrl.test(response.url()));
		await page.clock.fastForward(21_000);
		await refresh;
		const roster = page.locator('#line-detail-live').getByRole('table');
		await expect(roster.locator('tbody tr')).toHaveCount(20);
		await expect(page.locator('[data-slot="screen-answer"]')).toContainText('21');
		await expect(page.locator('#line-detail-live')).toContainText(
			fr ? /retard inconnu/i : /delay unknown/i,
		);
		await expect(roster.getByRole('link', { name: /40-298/ })).toHaveAttribute(
			'href',
			/\/vehicle\/40-298\?/,
		);
		await expect(roster.getByRole('link', { name: /1$/ }).first()).toHaveAttribute(
			'href',
			/\/stop\/t4-0\?/,
		);
		await expect(page.locator('#line-detail-directions')).toContainText(fr ? 'dans 5' : 'in 5');
		await page.getByRole('button', { name: fr ? 'Afficher 1 de plus' : 'Show 1 more' }).click();
		await expect(roster.locator('tbody tr')).toHaveCount(21);
		await page.goto(localizeHref('/lines/9003', locale, provider));
		await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
		expect(legacyRequests).toEqual([]);
	});

	test(`${locale}: schedule-only and unknown lines have no Live zero`, async ({ page }) => {
		await page.goto(localizeHref('/lines/9004?frameMode=live', locale, provider));
		await expect(page.locator('[data-slot="screen-answer"]')).toContainText(
			locale === 'fr' ? 'Aucune donnée en direct pour cette ligne' : 'No live data for this line',
		);
		await expect(page.locator('#schedule')).toBeVisible();
		await expect(
			page.getByRole('heading', {
				name: locale === 'fr' ? 'Ce qui ne peut pas être mesuré' : 'What cannot be measured',
			}),
		).toBeVisible();
		await expect(page.locator('#line-detail-live')).toHaveCount(0);

		const missing = await page.goto(
			localizeHref('/lines/line-does-not-exist?frameMode=live', locale, provider),
		);
		expect(missing?.status()).toBe(404);
		await expect(page.getByRole('heading', { level: 1 })).toContainText(
			locale === 'fr'
				? 'Cette ligne ne figure pas à l’horaire.'
				: 'This line is not in the timetable.',
		);
	});
}
