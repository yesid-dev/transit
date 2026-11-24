import { expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { test } from './layout-test';
import { localizeHref } from '../src/lib/i18n/routing';
import { captureUrl, layoutCapture } from './capture-fixture';

// The stop record's answer stays where it first painted while the agency's current notices and
// the stop's own file arrive. Production showed the notice strip, inserted above the answer once
// a fresh alert report landed, push it 231 to 277 px down on a 390 px phone (CLS 0.06 to 0.08),
// and a late stop file push it 29 px when the lines row appeared.

const generated = JSON.parse(readFileSync(new URL('./trips.json', import.meta.url), 'utf8'))
	.generated_utc as string;
const VIEWPORTS = [
	{ width: 390, height: 844 },
	{ width: 1280, height: 900 },
] as const;

/** A fresh report with one notice in effect that names the fixture stop. */
const notice = {
	id: 'layout-stop-notice',
	severity: 'WARNING',
	routes: ['80'],
	stops: ['S1'],
	header: {
		fr: 'L’ascenseur de la station est hors service jusqu’à nouvel ordre. Utilisez l’entrée nord.',
		en: 'The station elevator is out of service until further notice. Use the north entrance.',
	},
	description: {},
	url: {
		fr: 'https://www.stm.info/fr/infos/etat-du-service',
		en: 'https://www.stm.info/en/info/service-status',
	},
	cause: null,
	effect: null,
	periods: [],
};

async function serve(page: Page) {
	const gate = { holding: true, entered: () => {}, releases: [] as Array<() => void> };
	await page.route(captureUrl, async (route) => {
		if (gate.holding) {
			gate.entered();
			await new Promise<void>((resolve) => gate.releases.push(resolve));
		}
		return route.fulfill({ json: { ...layoutCapture('stm'), alerts: [notice] } });
	});
	return gate;
}

const settle = (page: Page) =>
	page.evaluate(() =>
		Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 2000))]),
	);
const frames = (page: Page) =>
	page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

// The other views lead with their first section; the alert report must not push it either.
// Schedule shows the strip (production: +193 px, CLS 0.05-0.06); Live now holds the notices in
// its own second section and shows no strip.
const VIEWS = [
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
			const gate = await serve(page);
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
