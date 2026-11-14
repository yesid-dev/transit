import { readFileSync } from 'node:fs';
import { expect, type Locator, type Page } from '@playwright/test';
import { test } from './layout-test';
import { expectLayout } from './layout-debt';
import { forwardRoute } from './layout-helpers';
import { navPillCopy } from '../src/lib/i18n/messages';
import { localizeHref } from '../src/lib/i18n/routing';

const stop = JSON.parse(readFileSync(new URL('./stops-index.json', import.meta.url), 'utf8'))
	.stops[0];
const address = { lat: stop.lat, lon: stop.lon, label: 'Fixture address', source: 'geo_ca' };
const epoch = Date.parse(
	JSON.parse(readFileSync(new URL('./departures.json', import.meta.url), 'utf8')).generated_utc,
);

const boxes = (list: Locator) =>
	list.locator('[role="option"]').evaluateAll((options) =>
		options.map((option) => {
			const r = option.getBoundingClientRect();
			return { id: option.id, top: r.top, left: r.left, right: r.right, bottom: r.bottom };
		}),
	);

// Every row stays inside the viewport; the pinned row (or, with no match, the message) is in view.
async function expectInView(page: Page, list: Locator) {
	const { width, height } = page.viewportSize()!;
	const outside = (await boxes(list)).filter(
		(box) => box.left < 0 || box.right > width || box.bottom > height,
	);
	expect(outside, 'options outside the viewport').toEqual([]);
	const pinned = list.locator('[id$="-all"]');
	await expect(
		(await pinned.count()) ? pinned : page.locator('.search-list-none'),
	).toBeInViewport();
}

for (const locale of ['en', 'fr'] as const)
	for (const query of [stop.name, 'zzzz'])
		test(`${locale} header search list "${query}" stays in view, rows stay put @layout`, async ({
			page,
		}, info) => {
			// The dropdown is the header from 1024 px; narrower headers get the sheet (P11).
			if (page.viewportSize()!.width < 1024)
				await page.setViewportSize({ width: 1024, height: 768 });
			let release!: () => void;
			const addressesArrive = new Promise<void>((resolve) => (release = resolve));
			await page.clock.setFixedTime(epoch + 30_000);
			await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
			// Like every layout spec with data: WebKit refuses the data origin unless Playwright serves it.
			await page.route('**/v1/**', (route) =>
				forwardRoute(page, async () => {
					const url = new URL(route.request().url());
					url.pathname = `/__layout/fresh${url.pathname.replace('/octranspo/', '/stm/')}`;
					await route.fulfill({ response: await route.fetch({ url: url.href }) });
				}),
			);
			await page.route('**/api/geocode**', async (route) => {
				await addressesArrive;
				await route.fulfill({ json: { results: [{ ...address, precision: 'address' }] } });
			});
			try {
				await page.goto(localizeHref('/', locale), { waitUntil: 'networkidle' });
				// Typing before hydration is reset; one held geocoder request is the one this test releases.
				await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
				const name = navPillCopy[locale].searchAria.all;
				const list = page.getByRole('listbox', { name });
				await expect(async () => {
					await page.getByRole('combobox', { name }).fill(query);
					await expect(list.getByRole('option').first()).toBeVisible({ timeout: 1_000 });
				}).toPass();
				await page.evaluate(() => document.fonts.ready);
				await expectInView(page, list);
				const before = (await boxes(list)).filter((box) => !box.id.endsWith('-all'));

				release();
				await expect(list.getByRole('option', { name: new RegExp(address.label) })).toBeVisible();
				const after = new Map((await boxes(list)).map((box) => [box.id, box]));
				expect(before.map((box) => after.get(box.id))).toEqual(before);
				await expectInView(page, list);
				await expectLayout(page, info, []);
			} finally {
				// A held geocoder answer would otherwise hang the page teardown after an early failure.
				release();
			}
		});
