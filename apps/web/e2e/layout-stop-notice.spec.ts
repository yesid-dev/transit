import { expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { test } from './layout-test';
import { localizeHref } from '../src/lib/i18n/routing';

// The stop record's answer stays where it first painted while the agency's current notices and
// the stop's own file arrive. Production showed the notice strip, inserted above the answer once
// a fresh alert report landed, push it 231 to 277 px down on a 390 px phone (CLS 0.06 to 0.08),
// and a late stop file push it 29 px when the lines row appeared.

const generated = JSON.parse(readFileSync(new URL('./trips.json', import.meta.url), 'utf8'))
	.generated_utc as string;
const cors = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
const VIEWPORTS = [
	{ width: 390, height: 844 },
	{ width: 1280, height: 900 },
] as const;

/** A fresh report with one notice in effect that names the fixture stop. */
const alerts = {
	generated_utc: generated,
	feed_captured_utc: generated,
	alerts: [
		{
			id: 'layout-stop-notice',
			header_key: 'layout-stop-notice',
			severity: 'high',
			routes: ['80'],
			stops: ['S1'],
			header_text:
				'L’ascenseur de la station est hors service jusqu’à nouvel ordre. Utilisez l’entrée nord.',
			header_text_en:
				'The station elevator is out of service until further notice. Use the north entrance.',
			url: 'https://www.stm.info/fr/infos/etat-du-service',
			url_en: 'https://www.stm.info/en/info/service-status',
		},
	],
};

const unseededStop = {
	generated_utc: generated,
	id: 'UNSEEDED',
	// The page already titles the stop by its id; the same name keeps this test on the identity row.
	name: 'UNSEEDED',
	lat: 45.5,
	lon: -73.6,
	routes_served: ['80'],
	wheelchair_boarding: 'yes',
};

async function serve(page: Page, held: RegExp) {
	const gate = { holding: true, entered: () => {}, releases: [] as Array<() => void> };
	await page.route('**/v1/**', async (route) => {
		const url = new URL(route.request().url());
		url.pathname = '/__layout/fresh' + url.pathname.replace('/octranspo/', '/stm/');
		if (held.test(url.pathname) && gate.holding) {
			gate.entered();
			await new Promise<void>((resolve) => gate.releases.push(resolve));
		}
		if (url.pathname.endsWith('/live/alerts.json'))
			return route.fulfill({ json: alerts, headers: cors });
		// The server could not read this stop (data.mjs), so the browser loads it here.
		if (url.pathname.endsWith('/static/stops/UNSEEDED.json'))
			return route.fulfill({ json: unseededStop, headers: cors });
		await route.fulfill({ response: await route.fetch({ url: url.href }) });
	});
	return gate;
}

const answerTop = (page: Page) =>
	page.evaluate(
		() =>
			document
				.querySelector('[role="tabpanel"][data-state="active"] [data-slot="stop-record-answer"]')
				?.getBoundingClientRect().top ?? null,
	);

const settle = (page: Page) =>
	page.evaluate(() =>
		Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 2000))]),
	);
const frames = (page: Page) =>
	page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

for (const locale of ['en', 'fr'] as const)
	test(`${locale} stop record answer keeps still while current notices arrive`, async ({
		page,
	}) => {
		await page.clock.setFixedTime(Date.parse(generated) + 30_000);
		const gate = await serve(page, /\/live\/alerts\.json$/);
		try {
			for (const viewport of VIEWPORTS) {
				gate.holding = true;
				const entered = new Promise<void>((resolve) => (gate.entered = resolve));
				await page.setViewportSize(viewport);
				await page.goto(`${localizeHref('/stop/S1', locale)}?provider=stm`, {
					waitUntil: 'domcontentloaded',
				});
				// The browser asks for the alert report once the page runs; the answer is already there.
				await entered;
				await expect(page.locator('[data-slot="stop-record-answer"]:visible')).toBeVisible();
				await settle(page);
				const before = await answerTop(page);
				expect(before, `${viewport.width} px`).not.toBeNull();

				gate.holding = false;
				for (const release of gate.releases.splice(0)) release();
				// The notice is current: the strip shows on the record, and the answer stays put.
				await expect(page.locator('[data-slot="stop-current-notice"]:visible')).toBeVisible();
				await frames(page);
				expect(await answerTop(page), `${viewport.width} px`).toBe(before);
			}
		} finally {
			gate.holding = false;
			for (const release of gate.releases.splice(0)) release();
		}
	});

// The other views lead with their first section; the alert report must not push it either.
// Schedule shows the strip (production: +193 px, CLS 0.05-0.06); Live now holds the notices in
// its own second section and shows no strip.
const VIEWS = [
	{ tab: 'schedule', first: 'stop-schedule-service', arrived: '[data-slot="stop-current-notice"]' },
	{ tab: 'detail', first: 'stop-detail-departures', arrived: '[data-testid="stop-alerts"]' },
] as const;

const sectionTop = (page: Page, id: string) =>
	page.evaluate(
		(id) =>
			document
				.querySelector(`[role="tabpanel"][data-state="active"] [data-toc="${id}"]`)
				?.getBoundingClientRect().top ?? null,
		id,
	);

for (const { tab, first, arrived } of VIEWS)
	for (const locale of ['en', 'fr'] as const)
		test(`${locale} stop ${tab} view keeps its first section still while current notices arrive`, async ({
			page,
		}) => {
			await page.clock.setFixedTime(Date.parse(generated) + 30_000);
			const gate = await serve(page, /\/live\/alerts\.json$/);
			try {
				for (const viewport of VIEWPORTS) {
					gate.holding = true;
					const entered = new Promise<void>((resolve) => (gate.entered = resolve));
					await page.setViewportSize(viewport);
					await page.goto(`${localizeHref('/stop/S1', locale)}?provider=stm&tab=${tab}`, {
						waitUntil: 'domcontentloaded',
					});
					await entered;
					await expect(
						page.locator(`[role="tabpanel"][data-state="active"] [data-toc="${first}"]`),
					).toBeVisible();
					await settle(page);
					const before = await sectionTop(page, first);
					expect(before, `${viewport.width} px`).not.toBeNull();

					gate.holding = false;
					for (const release of gate.releases.splice(0)) release();
					await expect(page.locator(`${arrived}:visible`).first()).toBeVisible();
					await frames(page);
					expect(await sectionTop(page, first), `${viewport.width} px`).toBe(before);
				}
			} finally {
				gate.holding = false;
				for (const release of gate.releases.splice(0)) release();
			}
		});

for (const locale of ['en', 'fr'] as const)
	test(`${locale} stop record answer keeps still while the stop's own file arrives`, async ({
		page,
	}) => {
		const gate = await serve(page, /\/static\/stops\/UNSEEDED\.json$/);
		try {
			for (const viewport of VIEWPORTS) {
				gate.holding = true;
				const entered = new Promise<void>((resolve) => (gate.entered = resolve));
				await page.setViewportSize(viewport);
				await page.goto(`${localizeHref('/stop/UNSEEDED', locale)}?provider=stm`, {
					waitUntil: 'domcontentloaded',
				});
				await entered;
				await expect(page.locator('[data-slot="stop-record-answer"]:visible')).toBeVisible();
				await settle(page);
				const before = await answerTop(page);
				expect(before, `${viewport.width} px`).not.toBeNull();

				gate.holding = false;
				for (const release of gate.releases.splice(0)) release();
				// The lines and access row fills the room it held.
				await expect(page.locator('[data-slot="stop-access"]:visible')).toBeVisible();
				await frames(page);
				expect(await answerTop(page), `${viewport.width} px`).toBe(before);
			}
		} finally {
			gate.holding = false;
			for (const release of gate.releases.splice(0)) release();
		}
	});
