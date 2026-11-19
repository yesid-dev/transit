import { expect, type Page } from '@playwright/test';
import { test } from './layout-test';
import { localizeHref } from '../src/lib/i18n/routing';

// The stop pages at phone, tablet and desktop widths, in English and French. Production showed
// the stop's hour labels running together on a 390 px phone ("0:003:006:00…") and the Stops
// finder's footer pushed down when its list replaced the loading card (CLS 0.06 to 0.09).

const WIDTHS = [320, 390, 768, 1280] as const;
// The hour chart's section heading (the copy module itself pulls in UI source Playwright cannot load).
const HABITS_HEADING = {
	en: 'Relative severe-delay score by hour',
	fr: 'Score relatif des retards graves par heure',
} as const;
const cors = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };

/** A network the size of a real first page and more: long and short names, every mode, codes. */
function stopsIndex() {
	const names = [
		'Station Angrignon (des Trinitaires / Lamont)',
		'Airport O-TRAIN North / Aéroport O-TRAIN Nord',
		'de la Commune / McGill',
		'Sherbrooke / Saint-Denis',
		'Côte-des-Neiges / Jean-Brillant',
		'Bayview',
		'Henri-Bourassa / Lajeunesse (Terminus Henri-Bourassa)',
		'Parc / Laurier',
	];
	const modes = ['bus', 'bus', 'metro', 'bus', 'tram', 'bus', 'rail', 'bus'];
	return {
		generated_utc: '2026-06-15T05:00:00Z',
		stops: Array.from({ length: 64 }, (_, index) => ({
			id: `L${String(index).padStart(3, '0')}`,
			// A sortable prefix keeps the first page a mix of long and short names.
			name: `${String.fromCharCode(65 + (index % 26))} ${names[index % names.length]}`,
			code: String(50000 + index),
			lat: 45.5 + index * 0.001,
			lon: -73.6,
			mode: modes[index % modes.length],
			routes: index % 3 === 0 ? ['80', '24', '1'] : ['80'],
		})),
	};
}

/** Seven days of 24 hourly relative scores, a few hours unmeasured, as the publisher writes them. */
function habitsReliability() {
	return {
		generated_utc: '2026-06-15T12:00:00Z',
		id: 'S1',
		periods: [{ grain: 'week', otp_pct: 80, avg_delay_min: 2, severe_pct: 20 }],
		habits: {
			scale: 'severe_relative',
			matrix: Array.from({ length: 7 }, (_, day) =>
				Array.from({ length: 24 }, (_, hour) =>
					hour < 4 && day % 2 === 0 ? null : ((day * 24 + hour) % 10) / 10,
				),
			),
		},
	};
}

async function serve(page: Page, held: RegExp | null) {
	const gate = { holding: held != null, entered: () => {}, releases: [] as Array<() => void> };
	const index = stopsIndex();
	await page.route('**/v1/**', async (route) => {
		const url = new URL(route.request().url());
		url.pathname = '/__layout/fresh' + url.pathname.replace('/octranspo/', '/stm/');
		if (held?.test(url.pathname) && gate.holding) {
			gate.entered();
			await new Promise<void>((resolve) => gate.releases.push(resolve));
		}
		if (url.pathname.endsWith('/static/stops_index.json'))
			return route.fulfill({ json: index, headers: cors });
		if (url.pathname.endsWith('/historic/stop_reliability/S1.json'))
			return route.fulfill({ json: habitsReliability(), headers: cors });
		await route.fulfill({ response: await route.fetch({ url: url.href }) });
	});
	return gate;
}

const settleFonts = (page: Page) =>
	page.evaluate(() =>
		Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 2000))]),
	);

for (const locale of ['en', 'fr'] as const) {
	test(`${locale} stop hour labels never run together`, async ({ page }) => {
		await serve(page, null);
		const heading = HABITS_HEADING[locale];
		for (const width of WIDTHS) {
			await page.setViewportSize({ width, height: 900 });
			await page.goto(`${localizeHref('/stop/S1', locale)}?provider=stm&tab=reliability`, {
				waitUntil: 'domcontentloaded',
			});
			// The section's own disclosure; the contents rail names the section too.
			const trigger = page
				.locator('[data-toc="stop-rel-habits"] [data-section-trigger]')
				.filter({ hasText: heading });
			await trigger.scrollIntoViewIfNeeded();
			if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
			const mark = page.locator('[data-slot="heatmap-mark"]');
			await mark.scrollIntoViewIfNeeded();
			await expect(mark.locator('rect.dv-heatmap-cell').first()).toBeVisible();
			await settleFonts(page);
			const ticks = await mark.evaluate((figure) =>
				[...figure.querySelectorAll('[data-slot="scroll-frame-scroller"] text')]
					.filter((text) => /^\d\d:\d\d$/.test(text.textContent?.trim() ?? ''))
					.map((text) => {
						const box = text.getBoundingClientRect();
						return { label: text.textContent!.trim(), left: box.left, right: box.right };
					}),
			);
			expect(
				ticks.map((tick) => tick.label),
				`${width} px`,
			).toEqual(['00:00', '03:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00']);
			// Each label ends at least 4 px before the next begins.
			for (let i = 1; i < ticks.length; i++)
				expect(
					ticks[i].left - ticks[i - 1].right,
					`${width} px ${ticks[i].label}`,
				).toBeGreaterThanOrEqual(4);
			// The cells may scroll beside the day names; the page itself never does.
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
				width,
			);
		}
	});

	test(`${locale} Stops finder keeps its footer still while the list loads`, async ({ page }) => {
		const gate = await serve(page, /\/static\/stops_index\.json$/);
		const frame = () =>
			page.evaluate(() => {
				const top = (selector: string) =>
					document.querySelector(selector)?.getBoundingClientRect().top ?? null;
				return {
					search: top('[data-testid="stops-filter-input"]'),
					footer: top('[data-testid="footer"]'),
				};
			});
		try {
			for (const width of WIDTHS) {
				gate.holding = true;
				const entered = new Promise<void>((resolve) => (gate.entered = resolve));
				await page.setViewportSize({ width, height: 900 });
				await page.goto(`${localizeHref('/stops', locale)}?provider=stm`, {
					waitUntil: 'domcontentloaded',
				});
				await entered;
				await expect(page.locator('[data-testid="footer"]')).toBeAttached();
				await settleFonts(page);
				const before = await frame();
				expect(before.footer, `${width} px`).not.toBeNull();

				gate.holding = false;
				for (const release of gate.releases.splice(0)) release();
				await expect(page.locator('[data-slot="entity-result-row"]:visible')).toHaveCount(20);
				await page.evaluate(
					() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
				);
				expect(await frame(), `${width} px`).toEqual(before);
			}
		} finally {
			gate.holding = false;
			for (const release of gate.releases.splice(0)) release();
		}
	});
}
