import { expect, test } from '@playwright/test';
import { installHealthCapture } from './capture-fixture';

const period = 'recordFrom=2026-11-20&recordTo=2026-11-22';

for (const locale of ['en', 'fr'] as const) {
	for (const city of ['stm', 'octranspo'] as const) {
		test(`Network health Record and Live for ${city} in ${locale}`, async ({ page }) => {
			const forbidden: string[] = [];
			page.on('request', (request) => {
				if (/\/(?:data\/)?v1\//.test(request.url())) forbidden.push(request.url());
			});
			const root = locale === 'fr' ? '/fr' : '';
			await page.goto(`${root}/network?provider=${city}&frameMode=record&${period}`);
			// Content is drawn on the server; controls answer once the page has hydrated.
			await expect(page.locator('html[data-hydrated]')).toBeAttached();
			const main = page.getByRole('main');
			await expect(main.getByRole('heading', { level: 1 })).toHaveAccessibleName(
				locale === 'fr' ? 'Santé du réseau' : 'Network health',
			);
			await expect(main.locator('[data-slot="screen-answer"]')).toContainText(/80[.,]7\s*%/);
			const delay = main.locator('#delay');
			await expect(delay.locator('[data-slot="chart-frame"]')).toBeVisible();
			const tableLabel = locale === 'fr' ? 'Tableau' : 'Table';
			for (const id of ['delay', 'trend', 'hours']) {
				const card = main.locator('#' + id);
				const footer = card.locator('footer');
				const controls = `network-${id}`;
				await expect(card.locator(`button[aria-controls="${controls}"]`)).toHaveCount(1);
				const tableToggle = footer.getByRole('button', { name: tableLabel, exact: true });
				await expect(tableToggle).toHaveAttribute('aria-controls', controls);
				await expect(footer.locator('.hand-drawn-line')).toBeVisible();
				await expect(tableToggle).toHaveAttribute('aria-pressed', 'false');
				await tableToggle.click();
				await expect(tableToggle).toHaveAttribute('aria-pressed', 'true');
				await expect(card.getByRole('table')).toBeVisible();
				if (id === 'delay') {
					// A cell on wide screens; on a phone the count is the row's sentence.
					await expect(card.getByText(/^14[,\s]500$/u)).toBeVisible();
				}
				await tableToggle.click();
				await expect(tableToggle).toHaveAttribute('aria-pressed', 'false');
			}
			await expect(main.locator('#delivery dl dd').first()).toHaveCSS('text-align', 'right');
			await expect(
				main
					.locator('#hours [data-slot="hour-grid"]')
					.getByRole('listitem')
					.filter({ hasText: locale === 'fr' ? /^Non mesuré$/ : /^Not measured$/ }),
			).toBeVisible();
			await expect(
				main.getByRole('heading', { name: locale === 'fr' ? 'Places à bord' : 'Room on board' }),
			).toBeVisible();
			await expect(
				main.getByRole('heading', {
					name: locale === 'fr' ? 'Par heure et jour de la semaine' : 'By hour and weekday',
				}),
			).toBeVisible();
			await expect(
				main.getByText(locale === 'fr' ? 'Vérifications réussies des flux' : 'Feed check success'),
			).toHaveCount(0);

			await page.goto(`${root}/network?provider=${city}&frameMode=live&${period}`);
			await expect(page.locator('html[data-hydrated]')).toBeAttached();
			await expect(
				main.getByRole('heading', {
					name: locale === 'fr' ? 'Véhicules par état' : 'Vehicles by status',
				}),
			).toBeVisible();
			await expect(
				main.getByRole('heading', {
					name: locale === 'fr' ? 'Trajets silencieux' : 'Silent trips',
				}),
			).toBeVisible();
			await expect(main.locator('[data-slot="screen-answer"]')).toContainText(
				locale === 'fr' ? 'véhicule transmet sa position.' : 'vehicle is reporting now.',
			);
			expect(forbidden).toEqual([]);
		});
	}
}

test('Network health reads scheduled trips and individual silent trips from the live capture', async ({
	page,
}) => {
	const refresh = await installHealthCapture(page);
	await page.goto('/network?provider=stm&frameMode=live');
	await expect(page.locator('html[data-hydrated]')).toBeAttached();
	await refresh();
	const main = page.getByRole('main');
	await expect(main.locator('[data-slot="screen-answer"]')).toContainText(
		'1,262 of 1,306 trips scheduled now have a vehicle reporting. 364 vehicles are reporting in all.',
	);
	await expect(main.getByText('1,262', { exact: true })).toBeVisible();
	await expect(main.getByText('of 1,306', { exact: true })).toBeVisible();
	await expect(main.getByText('A count of vehicles at this moment, not a percentage.')).toHaveCount(
		0,
	);
	const silent = main.getByRole('table', { name: 'Scheduled trips with no vehicle reporting' });
	await expect(silent.getByRole('row')).toHaveCount(9);
	// Wide: one column each. Phone rows: the line, the time silent in bold, then departure and
	// direction in one sentence, under the one column header the rows keep.
	const phone = (await silent.getByRole('columnheader').count()) === 1;
	if (!phone)
		for (const name of ['Line', 'Departure', 'Toward', 'Silent for'])
			await expect(silent.getByRole('columnheader', { name })).toBeVisible();
	await expect(silent.getByText('40 min', { exact: true })).toBeVisible();
	// A trip whose direction the timetable cannot tell keeps the Unknown mark in its cell; the
	// phone sentence leaves the direction out rather than saying "unknown direction".
	if (phone) await expect(silent).not.toContainText(/unknown direction/u);
	else await expect(silent.getByText(/Unknown/u).first()).toBeVisible();
	await expect(silent.getByRole('link', { name: 'Sherbrooke' })).toHaveAttribute(
		'href',
		/\/lines\/24\?.*frameMode=live/u,
	);
	await expect(silent.getByRole('link', { name: /99999/u })).toHaveAttribute(
		'href',
		/\/lines\/99999\?/u,
	);
	await expect(main.getByText('Showing 8 of 12')).toBeVisible();
	await expect(main.getByText('44', { exact: true })).toBeVisible();
	await main.getByRole('button', { name: 'Show 4 more' }).click();
	await expect(silent.getByRole('row')).toHaveCount(13);
	await expect(main.getByText('Showing 12 of 12')).toBeVisible();
});

test('Network shows the unavailable state when the live capture fails after a successful reading', async ({
	page,
}) => {
	await page.clock.install();
	await page.route('**/api/live?city=stm', (route) =>
		route.fulfill({ status: 503, json: { state: 'unavailable' } }),
	);
	await page.goto('/network?provider=stm&frameMode=live');
	await expect(page.locator('html[data-hydrated]')).toBeAttached();
	await expect(page.getByText('vehicle is reporting now.')).toBeVisible();
	await expect(page.locator('html[data-hydrated]')).toHaveCount(1);
	await page.clock.runFor(21_000);
	await expect(page.getByText('No live data', { exact: true }).first()).toBeVisible();
	if (process.env.TRANSIT_E2E_HEALTH_SCREENSHOTS) {
		await page.screenshot({
			fullPage: true,
			path: 'test-results/health-evidence/pr20/stm-en-live-failing.png',
		});
	}
});

for (const locale of ['en', 'fr'] as const) {
	const fr = locale === 'fr';
	const root = fr ? '/fr' : '';
	test(`Network 24-hour grid follows the service day and keeps word states and phone scroll in ${locale}`, async ({
		page,
	}) => {
		// This week's fixture has all 24 hours and every named state.
		const fullDayPeriod = 'recordFrom=2026-10-19&recordTo=2026-10-25';
		for (const width of [1440, 390]) {
			await page.setViewportSize({ width, height: 900 });
			await page.goto(`${root}/network?provider=stm&frameMode=record&${fullDayPeriod}`);
			await expect(page.locator('html[data-hydrated]')).toBeAttached();
			const grid = page.locator('#hours [data-slot="hour-grid"]');
			await expect(grid.locator('tbody td')).toHaveCount(7 * 24);
			await page.evaluate(() => document.fonts.ready);
			const headers = grid.locator('thead th');
			await expect(headers).toHaveCount(24);
			await expect(headers.first()).toHaveText(fr ? '4 h' : '04h');
			await expect(headers.last()).toHaveText(fr ? '3 h' : '03h');
			await expect(page.locator('#hours')).toContainText(
				fr ? 'Un jour par case. Choisissez 28 jours' : 'One day per cell. Choose 28 days',
			);

			const metrics = await grid.evaluate((rootEl) => {
				const region = rootEl.querySelector<HTMLElement>('[role="region"]')!;
				const last = rootEl.querySelector('thead th:last-child')!;
				const inside = () => {
					const cell = last.getBoundingClientRect();
					const box = region.getBoundingClientRect();
					return cell.left >= box.left - 1 && cell.right <= box.right + 1;
				};
				const visibleInitially = inside();
				region.scrollLeft = region.scrollWidth;
				const visibleAfterScroll = inside();
				region.scrollLeft = 0;
				const tds = [...rootEl.querySelectorAll('tbody td')];
				const stateWords = (state: string) =>
					[...rootEl.querySelectorAll(`tbody td [data-state="${state}"]`)].map(
						(cell) => cell.textContent?.trim() ?? '',
					);
				const keys = [...rootEl.querySelectorAll<HTMLElement>('.legend li')].map((item) => {
					const swatch = item.querySelector<HTMLElement>('.swatch')!;
					const style = getComputedStyle(swatch);
					const filled = !['rgba(0, 0, 0, 0)', 'transparent'].includes(style.backgroundColor);
					const outlined = style.borderStyle !== 'none' && parseFloat(style.borderWidth) > 0;
					return { text: item.textContent?.trim() ?? '', drawn: filled || outlined };
				});
				return {
					labelled: Boolean(
						document
							.getElementById(region.getAttribute('aria-labelledby') ?? '')
							?.textContent?.trim(),
					),
					tabindex: region.getAttribute('tabindex'),
					unnamedCells: tds.filter((td) => !td.getAttribute('aria-label')?.trim()).length,
					few: stateWords('few'),
					none: stateWords('none'),
					unmeasured: stateWords('unmeasured').length,
					keys,
					scrolls: region.scrollWidth > region.clientWidth,
					visibleInitially,
					visibleAfterScroll,
					pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
				};
			});

			expect(metrics.pageOverflow, `${locale} ${width}px page overflow`).toBeLessThanOrEqual(0);
			expect(metrics.labelled).toBe(true);
			expect(metrics.tabindex).toBe('0');
			expect(metrics.unnamedCells).toBe(0);
			expect(metrics.few.length).toBeGreaterThan(0);
			expect(new Set(metrics.few)).toEqual(new Set([fr ? 'peu' : 'few']));
			expect(metrics.none.length).toBeGreaterThan(0);
			expect(new Set(metrics.none)).toEqual(new Set([fr ? 'aucun' : 'none']));
			expect(metrics.unmeasured).toBeGreaterThan(0);
			// Five scale steps and the three named states, each with a drawn key and its words.
			expect(metrics.keys).toHaveLength(8);
			for (const key of metrics.keys) {
				expect(key.text, `${locale} legend key`).not.toBe('');
				expect(key.drawn, `${locale} legend swatch for "${key.text}"`).toBe(true);
			}
			expect(metrics.visibleAfterScroll, `${locale} ${width}px 23h reachable`).toBe(true);
			if (width === 1440) {
				expect(metrics.scrolls, `${locale} 1440px grid fits its card`).toBe(false);
				expect(metrics.visibleInitially, `${locale} 1440px 23h in view`).toBe(true);
			} else {
				expect(metrics.scrolls, `${locale} 390px grid scrolls in its own region`).toBe(true);
			}
		}
	});
}
