import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { test } from './layout-test';
import { localizeHref } from '../src/lib/i18n/routing';
import { stampCopy } from '../src/lib/v1/stamp.copy';

// A record page's header has its final height before the record's files arrive: the dated stamp,
// the data health warning (W10) under it and the sections control all keep their room, so the
// first thing under the header never moves when they load.
const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const b9 = read('../scripts/__fixtures__/b9/rich.json').files;
const recordFile =
	/\/historic\/(?:route_reliability\/24|stop_reliability\/52095|hotspots)\.json$|\/historic\/history\/|\/status\/data_health\.json$/;
const pages = [
	{
		name: 'line',
		path: '/lines/24?provider=stm',
		first: '[data-slot="entity-detail-tabs"]',
		// The line's record is server-rendered from the b9 bundle.
		published: b9['historic/route_reliability/24.json'].generated_utc as string,
	},
	{
		name: 'stop',
		path: '/stop/52095?provider=stm',
		first: '[data-slot="entity-detail-tabs"]',
		// The fresh layout fixtures date every file like the trips file.
		published: read('./trips.json').generated_utc as string,
	},
	{ name: 'hotspots', path: '/hotspots?provider=stm', first: '[data-slot="hotspots-page"]' },
] as const;

async function holdRecordFiles(page: Page, published: string | undefined) {
	const gate = {
		holding: true,
		// Called when the page asks for a record file, which is then held.
		entered: () => {},
		releases: [] as Array<() => void>,
	};
	await page.route('**/v1/**', async (route) => {
		const url = new URL(route.request().url());
		url.pathname = '/__layout/fresh' + url.pathname;
		const held = recordFile.test(url.pathname) && gate.holding;
		if (held) {
			gate.entered();
			await new Promise<void>((resolve) => gate.releases.push(resolve));
		}
		if (url.pathname.endsWith('/status/data_health.json')) {
			// The rollup check warned on exactly this record's publication: W10 shows.
			await route.fulfill({
				json: {
					generated_utc: published ?? '2026-06-15T12:00:00Z',
					lanes: [{ lane: 'rollup', last_publish_utc: published, gate: { verdict: 'warn' } }],
				},
				headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
			});
			return;
		}
		await route.fulfill({ response: await route.fetch({ url: url.href }) });
	});
	return gate;
}

function frame(page: Page, first: string) {
	return page.evaluate((first) => {
		const header = document.querySelector('.transit-article-header')!.getBoundingClientRect();
		return {
			header: header.height,
			first: document.querySelector(first)!.getBoundingClientRect().top,
		};
	}, first);
}

for (const { name, path, first, ...record } of pages)
	for (const locale of ['en', 'fr'] as const)
		test(`${locale} ${name} header holds still while the record files load`, async ({ page }) => {
			const published = 'published' in record ? record.published : undefined;
			const gate = await holdRecordFiles(page, published);
			// The whole record: data through its history's last day, published by its own file.
			const [through, publishedOn] = stampCopy[locale].record('\0', '\0', 'window').split('\0');
			const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const complete = new RegExp(`${escape(through)}.+${escape(publishedOn)}.+`);
			try {
				for (const width of [320, 390, 768, 1280]) {
					gate.holding = true;
					const held = new Promise<void>((resolve) => (gate.entered = resolve));
					await page.setViewportSize({ width, height: 900 });
					await page.goto(localizeHref(path, locale), { waitUntil: 'domcontentloaded' });
					await expect(page.locator(first)).toBeVisible();
					await held;
					await page.evaluate(() =>
						Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 2000))]),
					);
					const before = await frame(page, first);

					gate.holding = false;
					for (const release of gate.releases.splice(0)) release();
					const stamp = page.locator('.transit-article-header .header__meta time');
					await expect(stamp).toHaveText(complete);
					if (published) {
						await expect(page.getByRole('link', { name: stampCopy[locale].warning })).toBeVisible();
						await expect(page.getByTestId('sections-toggle')).toBeVisible();
					}
					expect(await frame(page, first), `${width} px`).toEqual(before);
				}
			} finally {
				gate.holding = false;
				for (const release of gate.releases.splice(0)) release();
			}
		});
