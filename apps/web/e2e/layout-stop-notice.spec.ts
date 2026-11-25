import { expect } from '@playwright/test';
import { test } from './layout-test';
import { localizeHref } from '../src/lib/i18n/routing';
import { captureFixture, captureUrl, installStopCapture } from './capture-fixture';

const notice = {
	id: 'layout-stop-notice',
	severity: 'WARNING',
	routes: ['24'],
	stops: ['S1'],
	header: { en: 'Your stop', fr: 'Votre arrêt' },
	description: {
		en: 'The elevator is out of service. Use the north entrance.',
		fr: 'L’ascenseur est hors service. Utilisez l’entrée nord.',
	},
	url: {},
	cause: null,
	effect: null,
	periods: [],
};
const time = Date.parse('2026-11-23T16:00:00Z');

for (const locale of ['en', 'fr'] as const)
	test(`${locale}: Stop Live keeps its first section still while the notice arrives`, async ({
		page,
	}) => {
		const refresh = await installStopCapture(page, 'stm', 'S1', time);
		for (const width of [390, 1280]) {
			await page.setViewportSize({ width, height: 900 });
			await page.goto(localizeHref('/stop/S1?frameMode=live', locale, 'stm'));
			await refresh();
			const first = page.locator('#stop-detail-departures');
			await expect(first).toContainText(
				locale === 'fr' ? 'véhicules sont attendus' : 'vehicles are expected',
			);
			const before = (await first.boundingBox())?.y;
			const capture = async (route: import('@playwright/test').Route) => {
				const now = await page.evaluate(() => Date.now());
				await route.fulfill({ json: captureFixture(now, { alerts: [notice] }) });
			};
			await page.route(captureUrl, capture);
			await refresh();
			await expect(page.getByTestId('stop-alerts')).toContainText(
				locale === 'fr' ? 'L’ascenseur est hors service.' : 'The elevator is out of service.',
			);
			expect((await first.boundingBox())?.y).toBe(before);
			await page.unroute(captureUrl, capture);
		}
	});
