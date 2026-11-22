import { expect, type Page } from '@playwright/test';
import { test } from './layout-test';
import { localizeHref } from '../src/lib/i18n/routing';
import { stampCopy } from '../src/lib/v1/stamp.copy';

// The receipt keeps its reading position while the published record loads.
const pages = [
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
	await page.route('**/v1/**', async (route) => {
		const url = new URL(route.request().url());
		url.pathname = '/__layout/fresh' + url.pathname;
		if (held.test(url.pathname) && gate.holding) {
			gate.entered();
			await new Promise<void>((resolve) => gate.releases.push(resolve));
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
