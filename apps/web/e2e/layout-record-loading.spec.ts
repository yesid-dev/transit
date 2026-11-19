import { expect, type Page } from '@playwright/test';
import { test } from './layout-test';
import { localizeHref } from '../src/lib/i18n/routing';
import { stampCopy } from '../src/lib/v1/stamp.copy';

// Repeat offenders and the receipt keep still while their record loads: the header, the page's
// content column and the footer are where they were before the files arrived. Production showed
// the footer pushed down by the arriving ranking (CLS 0.41-0.47) and the receipt's header and
// sections growing (CLS about 1.05).

/** A current repeat-offenders file shaped like a published one: more rows than the first page
 * shows, both kinds, both periods, a tray of rows below the rule. Every figure obeys its checks. */
function offenders() {
	const lines = [
		['24', 'Sherbrooke'],
		['1-373', 'Confederation'],
	] as const;
	const entry = (type: 'trip' | 'vehicle', index: number, ranked: boolean) => {
		const [route, name] = lines[index % lines.length];
		return {
			type,
			id: `${type === 'trip' ? 3056330 : 46}${index}`,
			route,
			route_name: name,
			route_short_name: route === '24' ? '24' : '1',
			departure_time: null,
			headsign: null,
			...(ranked
				? {
						rank: index + 1,
						// 57 of 798 readings: 7.1 %, inside the published 5.6 % to 9.1 %.
						observation_count: 798,
						severe_count: 57,
						severe_pct: 7.1,
						wilson_lo: 90.9,
						wilson_hi: 94.4,
						recurrence_days: Math.max(2, 7 - Math.floor(index / 3)),
						observed_days: 7,
						avg_delay_min: Number((5 - index * 0.1).toFixed(1)),
					}
				: {
						// 1 of 20 readings: 5 %, inside 1 % to 20 %; below every floor.
						observation_count: 20,
						severe_count: 1,
						severe_pct: 5,
						wilson_lo: 80,
						wilson_hi: 99,
						recurrence_days: 1,
						observed_days: 2,
						avg_delay_min: 1.2,
					}),
		};
	};
	const grain = (name: 'week' | 'month', window: number) => ({
		grain: name,
		window_days: window,
		entries: (['trip', 'vehicle'] as const).flatMap((type) =>
			Array.from({ length: 14 }, (_, index) => entry(type, index, true)),
		),
		tray: (['trip', 'vehicle'] as const).flatMap((type) =>
			Array.from({ length: 6 }, (_, index) => entry(type, index, false)),
		),
		total_ranked_trips: 120,
		total_ranked_vehicles: 90,
		tray_total: 12,
	});
	return {
		generated_utc: '2026-06-15T12:00:00Z',
		methodology_version: 'reliability-2',
		by_grain: [grain('week', 7), grain('month', 30)],
	};
}

const pages = [
	{
		name: 'repeat offenders',
		path: '/repeat-offenders?provider=stm',
		held: /\/historic\/repeat_offenders/,
		first: '[data-slot="offenders-controls"]',
		// The record's own top: it must not move up when no history navigator arrives.
		record: '.offenders-record',
		loaded: '[data-slot="offender-rows"] > li > button:visible',
		scope: 'window',
	},
	{
		name: 'receipt',
		path: '/receipt?provider=stm',
		held: /\/historic\/receipts\//,
		first: '[data-slot="detail-shell-center"]',
		record: '[data-slot="receipt-sections"]',
		loaded: '[data-slot="receipt-headline"]:visible',
		scope: 'day',
	},
] as const;

async function holdFiles(page: Page, held: RegExp) {
	const gate = {
		holding: true,
		entered: () => {},
		releases: [] as Array<() => void>,
	};
	const current = offenders();
	await page.route('**/v1/**', async (route) => {
		const url = new URL(route.request().url());
		url.pathname = '/__layout/fresh' + url.pathname;
		if (held.test(url.pathname) && gate.holding) {
			gate.entered();
			await new Promise<void>((resolve) => gate.releases.push(resolve));
		}
		if (url.pathname.endsWith('/historic/repeat_offenders.json')) {
			await route.fulfill({
				json: current,
				headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
			});
			return;
		}
		await route.fulfill({ response: await route.fetch({ url: url.href }) });
	});
	return gate;
}

function frame(page: Page, first: string, record: string) {
	return page.evaluate(
		([first, record]) => {
			const top = (selector: string) =>
				document.querySelector(selector)?.getBoundingClientRect().top ?? null;
			return {
				header: document.querySelector('.transit-article-header')!.getBoundingClientRect().height,
				first: top(first),
				record: top(record),
				footer: top('[data-testid="footer"]'),
			};
		},
		[first, record],
	);
}

for (const { name, path, held, first, record, loaded, scope } of pages)
	for (const locale of ['en', 'fr'] as const)
		test(`${locale} ${name} holds still while its record loads`, async ({ page }) => {
			const gate = await holdFiles(page, held);
			// The record's stamp: its dates, then the day it was published.
			const [through, publishedOn] = stampCopy[locale].record('\0', '\0', scope).split('\0');
			const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const complete = new RegExp(`${escape(through)}.+${escape(publishedOn)}.+`);
			try {
				for (const width of [320, 390, 768, 1280]) {
					gate.holding = true;
					const entered = new Promise<void>((resolve) => (gate.entered = resolve));
					await page.setViewportSize({ width, height: 900 });
					await page.goto(localizeHref(path, locale), { waitUntil: 'domcontentloaded' });
					await expect(page.locator(first)).toBeVisible();
					await entered;
					await page.evaluate(() =>
						Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 2000))]),
					);
					const before = await frame(page, first, record);

					gate.holding = false;
					for (const release of gate.releases.splice(0)) release();
					await expect(page.locator(loaded).first()).toBeVisible();
					await expect(page.locator('.transit-article-header .header__meta time')).toHaveText(
						complete,
					);
					await page.evaluate(
						() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
					);
					expect(await frame(page, first, record), `${width} px`).toEqual(before);
				}
			} finally {
				gate.holding = false;
				for (const release of gate.releases.splice(0)) release();
			}
		});
