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
	test(`${locale}: Line Live uses the vehicle capture cadence for its notice and stamp`, async ({
		page,
	}) => {
		const fr = locale === 'fr';
		const staleNotice = fr
			? 'Les positions des véhicules ne sont plus à jour.'
			: 'Vehicle positions are out of date.';
		const lateStamp = fr ? 'pas à jour' : 'not current';
		let captureAge = 49;
		await page.clock.install();
		await page.route(captureUrl, async (route) => {
			const now = await page.evaluate(() => Date.now());
			const captured = now - captureAge * 1_000;
			const capture = captureFixture(now, {
				vehicle_positions: [captureVehicle(captured, { route_id: '9003', trip_id: 'trip-1' })],
			});
			const timestamp = new Date(captured).toISOString();
			Object.assign(capture.feeds.vehicle_positions!, {
				captured_at: timestamp,
				source_at: timestamp,
				expected_every_seconds: 30,
				fresh_for_seconds: 40,
			});
			await route.fulfill({ json: capture });
		});
		await page.goto(localizeHref('/lines/9003?frameMode=live', locale, provider), {
			waitUntil: 'networkidle',
		});
		await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
		const answer = page.locator('#line-detail-profile');
		await expect(answer).toBeVisible();
		await expect(
			answer.getByText(fr ? 'Vérification des signalements en direct…' : 'Checking live reports…'),
		).toHaveCount(0);
		async function refresh() {
			const response = page.waitForResponse((reply) => captureUrl.test(reply.url()));
			await page.clock.fastForward(21_000);
			await response;
		}
		await refresh();
		await expect(page.locator('#line-detail-live')).toBeVisible();
		await expect(answer).toContainText(fr ? 'En direct · mis à jour' : 'Live · updated');
		await expect(answer).not.toContainText(staleNotice);
		await expect(answer).not.toContainText(lateStamp);

		captureAge = 91;
		await refresh();
		await expect(answer).toContainText(staleNotice);
		await expect(answer).toContainText(lateStamp);
	});

	test(`${locale}: Line Live shows a paged roster, predictions, and the same title as Record`, async ({
		page,
	}) => {
		const fr = locale === 'fr';
		let vehicleCount = 13;
		const legacyRequests: string[] = [];
		page.on('request', (request) => {
			const url = new URL(request.url());
			if (url.pathname.startsWith('/v1/')) legacyRequests.push(url.pathname);
		});
		await page.clock.install();
		await page.route(captureUrl, async (route) => {
			const at = await page.evaluate(() => Date.now());
			const vehicles = Array.from({ length: vehicleCount }, (_, index) =>
				captureVehicle(at - 18_000, {
					vehicle_id: `40-${298 + index}`,
					route_id: '9003',
					trip_id: `trip-${index}`,
					delay: [-72, -60, 300, 390, null][index % 5],
					stop_id: `t4-${index % 5}`,
				}),
			);
			await route.fulfill({
				json: {
					...captureFixture(at, {
						vehicle_positions: vehicles,
						non_responding_by_route: [{ route_id: '9003', count: 2 }],
						alerts: [
							{
								id: 'shared-line-notice',
								header: { en: 'Your line', fr: 'Votre ligne' },
								description: { fr: 'Détour près du terminus. Suivez la signalisation temporaire.' },
								url: {},
								cause: null,
								effect: null,
								severity: null,
								routes: ['9003'],
								stops: [],
								periods: [
									[new Date(at - 3_600_000).toISOString(), new Date(at + 3_600_000).toISOString()],
								],
							},
						],
					}),
					stable_vehicle_ids: null,
				},
			});
		});
		await page.route('**/api/live-trips?city=stm&line=9003', async (route) => {
			const at = await page.evaluate(() => Date.now());
			await route.fulfill({
				json: captureTripReport('stm', new Date(at).toISOString(), [
					{
						...captureTrip(
							'trip-0',
							'9003',
							[
								{
									stop: 't4-0',
									eta_utc: new Date(at + 270_000).toISOString(),
									delay_min: 2,
									scheduled_utc: new Date(at + 150_000).toISOString(),
								},
							],
							120,
						),
						direction_id: 0,
						trip_headsign: 'Greenboro / Rockcliffe',
					},
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
		async function refreshLive() {
			const refresh = page.waitForResponse((response) => captureUrl.test(response.url()));
			await page.clock.fastForward(21_000);
			await refresh;
		}
		await refreshLive();
		const notices = page.getByRole('article', { name: fr ? 'Avis de l’agence' : 'Agency notices' });
		await expect(
			notices.getByRole('heading', { name: 'Détour près du terminus.' }),
		).toHaveAttribute('lang', 'fr');
		await expect(notices).toContainText(fr ? /Depuis le .*Jusqu’au / : /Since .*Until /);
		await expect(notices.getByText('Suivez la signalisation temporaire.')).toHaveAttribute(
			'lang',
			'fr',
		);
		const vehicleSection = page.locator('#line-detail-live');
		const roster = vehicleSection.getByRole('table');
		await expect(roster.locator('tbody tr')).toHaveCount(13);
		await expect(vehicleSection.getByText(fr ? '13 sur 13' : 'Showing 13 of 13')).toHaveCount(0);
		vehicleCount = 21;
		await refreshLive();
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
		const predictions = page.locator('#line-detail-directions');
		await expect(predictions).toContainText(fr ? 'dans 5' : 'in 5');
		await expect(predictions).toContainText(fr ? 'Vers Greenboro' : 'Toward Greenboro');
		await expect(predictions).toContainText(fr ? /Prévu à \d\d:\d\d/ : /Scheduled \d\d:\d\d/);
		await expect(predictions.getByRole('link').first().locator('[data-slot="badge"]')).toHaveText(
			't4-0',
		);
		await page.getByRole('button', { name: fr ? 'Afficher 1 de plus' : 'Show 1 more' }).click();
		await expect(roster.locator('tbody tr')).toHaveCount(21);
		await page.goto(localizeHref('/lines/9003', locale, provider));
		await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
		expect(legacyRequests).toEqual([]);
	});

	test(`${locale}: schedule-only lines have no Live zero`, async ({ page }) => {
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
	});

	test(`${locale}: a seasonal line remains readable in Record and reachable from Live`, async ({
		page,
	}) => {
		const fr = locale === 'fr';
		const notice = fr
			? 'Cette ligne ne figure pas à l’horaire actuel.'
			: 'This line is not in the current timetable.';
		const dates = 'recordFrom=2026-11-08&recordTo=2026-11-14';
		const live = await page.goto(
			localizeHref(`/lines/seasonal?tab=detail&${dates}`, locale, provider),
		);
		expect(live?.status()).toBe(200);
		const answer = page.locator('[data-slot="screen-answer"]');
		await expect(answer.getByText(notice, { exact: true })).toBeVisible();
		await expect(page.locator('#line-detail-live')).toHaveCount(0);

		const titleBlock = page.locator('header').filter({ has: page.locator('#line-title') });
		const titleBoundary = page.locator(
			'[data-record-screen] [data-slot="page-section-boundary"].hand-drawn-line:has(+ [data-slot="page-section"] [data-slot="screen-answer"])',
		);
		await expect(titleBoundary).toHaveCount(1);
		const headerHeight = (await titleBlock.boundingBox())?.height;
		await answer.getByRole('link', { name: fr ? 'Voir le bilan' : 'View record' }).click();
		await expect(page).toHaveURL(
			(url) => url.searchParams.get('frameMode') === 'record' && url.search.includes(dates),
		);
		await expect(titleBlock.getByText(notice, { exact: true })).toBeVisible();
		await expect(titleBoundary).toHaveCount(1);
		expect((await titleBlock.boundingBox())?.height).toBe(headerHeight);
		await expect(answer).toContainText(fr ? '80,0 %' : '80.0%');

		const record = await page.reload();
		expect(record?.status()).toBe(200);
		await expect(answer).toContainText(fr ? '80,0 %' : '80.0%');
	});
}
