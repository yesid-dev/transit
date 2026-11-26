import { expect, type Page } from '@playwright/test';
import { localizeHref } from '../src/lib/i18n/routing';
import { navPillCopy } from '../src/lib/i18n/messages';
import { test } from './layout-test';
import { textDefects, waitForFrameClearance } from './layout-helpers';
import { openFrameControls } from './frame-controls';
import { frameCopy } from '../src/lib/components/shell/frameCopy';

const cities = {
	stm: {
		en: 'Source: Société de transport de Montréal (STM), CC BY 4.0.',
		fr: 'Source : Société de transport de Montréal (STM), CC BY 4.0.',
	},
	octranspo: {
		en: 'Contains information licensed under the Open Government Licence – City of Ottawa.',
		fr: 'Contient de l’information visée par la Licence du gouvernement ouvert – Ville d’Ottawa.',
	},
};

const agencyByCity: Record<string, string> = { stm: 'STM', octranspo: 'OC Transpo' };
const taglines = {
	en: 'An independent public record of the transit service delivered. Not a trip planner.',
	fr: 'Un bilan public et indépendant du service de transport livré. Pas un planificateur de trajets.',
};

async function open(page: Page, href: string) {
	await page.goto(href);
	await expect(page.locator('html[data-hydrated]')).toHaveCount(1);
}

for (const locale of ['en', 'fr'] as const) {
	const words = navPillCopy[locale];
	for (const width of [390, 1440]) {
		test(`${locale} View hints follow the selected mode at ${width}px`, async ({ page }) => {
			await page.setViewportSize({ width, height: 900 });
			const copy = frameCopy[locale];
			for (const mode of ['live', 'record'] as const) {
				await open(page, localizeHref(`/vehicles?frameMode=${mode}`, locale, 'stm'));
				const controls = await openFrameControls(page, locale);
				const choice = controls.getByRole('group', { name: copy.view });
				await expect(choice.getByText(copy.viewHint[mode], { exact: true })).toHaveCount(1);
				await expect(
					choice.getByText(copy.viewHint[mode === 'live' ? 'record' : 'live'], { exact: true }),
				).toHaveCount(0);
			}
		});
	}
	test(`${locale} compact header reaches the city after the menu and clears the content`, async ({
		page,
		browserName,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await open(page, localizeHref('/lines', locale, 'stm'));
		const site = page.getByTestId('nav-pill');
		const menu = site.getByTestId('nav-menu-toggle');
		const city = site.getByRole('combobox', { name: words.network });
		await expect(city).toBeVisible();
		await expect(site.getByTestId('theme-toggle')).toBeVisible();
		await expect(site.getByTestId('language-toggle')).toBeVisible();
		expect((await page.getByRole('main').boundingBox())!.y).toBeLessThanOrEqual(140);
		// WebKit does not Tab between all native controls in its default keyboard mode.
		if (browserName === 'chromium') {
			await menu.focus();
			await page.keyboard.press('Tab');
			await expect(city).toBeFocused();
		}
	});

	test(`${locale} city select provides a 44px activation target`, async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await open(page, localizeHref('/lines', locale, 'stm'));
		const city = page.getByTestId('nav-pill').getByRole('combobox', { name: words.network });
		expect((await city.boundingBox())!.height).toBeGreaterThanOrEqual(44);
	});

	test(`${locale} from 1024 to 1279px the header keeps the page links and a search button`, async ({
		page,
	}) => {
		const current = { en: 'Lines', fr: 'Lignes' }[locale];
		for (const width of [1024, 1180, 1279, 1280]) {
			await page.setViewportSize({ width, height: 900 });
			await open(page, localizeHref('/lines', locale, 'stm'));
			await page.evaluate(() => document.fonts.ready);
			const pill = page.getByTestId('nav-pill');
			const links = pill.locator('.nav-links a:visible');
			await expect(links, `${width}px page links`).toHaveCount(4);
			await expect(pill.locator('.nav-links a[aria-current="page"]')).toHaveText(current);
			const button = pill.getByRole('button', { name: words.searchAria.all, exact: true });
			const field = pill.getByRole('combobox', { name: words.searchAria.all });
			if (width < 1280) {
				await expect(button).toBeVisible();
				await expect(field).toHaveCount(0);
			} else {
				await expect(button).toHaveCount(0);
				await expect(field).toBeVisible();
			}
			// The city stays in the pill's row, so the chrome keeps the 1280px height.
			const row = await pill.evaluate((nav) => {
				const top = (selector: string) =>
					Math.round(nav.querySelector(selector)!.getBoundingClientRect().top);
				return {
					theme: top('[data-testid="theme-toggle"]'),
					city: top('[data-slot="site-header-network"]'),
					below: nav.hasAttribute('data-network-below'),
				};
			});
			expect(row.below, `${width}px city below the pill`).toBe(false);
			expect(row.city).toBe(row.theme);
			const bounds = (await pill.boundingBox())!;
			expect(bounds.x).toBeGreaterThanOrEqual(0);
			expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
		}
	});

	test(`${locale} the compact search button and city fit at 1024px and 200% text`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1024, height: 900 });
		await open(page, localizeHref('/privacy', locale, 'stm'));
		await page.addStyleTag({ content: 'html { font-size: 200%; }' });
		await page.evaluate(() => document.fonts.ready);
		const pill = page.getByTestId('nav-pill');
		await expect(page.locator('[data-slot="app-frame"]')).toHaveAttribute(
			'data-rail-layout',
			'compact',
		);
		await expect(pill.getByRole('combobox', { name: words.searchAria.all })).toHaveCount(0);
		await expect(pill.getByRole('button', { name: words.searchAria.all })).toBeVisible();
		await expect(pill.getByRole('combobox', { name: words.network })).toBeVisible();
		const bounds = (await pill.boundingBox())!;
		expect(bounds.x).toBeGreaterThanOrEqual(0);
		expect(bounds.x + bounds.width).toBeLessThanOrEqual(1024);
	});

	test(`${locale} compact header keeps pill fixed, vacated band clickable, city reachable and fits at 200% text across 390, 768 and 1023px`, async ({
		page,
		browserName,
	}) => {
		for (const width of [390, 768, 1023]) {
			await page.setViewportSize({ width, height: 844 });
			await open(page, localizeHref('/privacy', locale, 'stm'));
			await waitForFrameClearance(page);
			const pill = page.getByTestId('nav-pill');
			const network = pill.locator('[data-slot="site-header-network"]');
			const search = pill.getByRole('button', { name: words.searchAria.all });
			const menu = pill.getByTestId('nav-menu-toggle');
			await expect(network).toBeVisible();
			const pillStart = (await pill.boundingBox())!;
			const networkStart = (await network.boundingBox())!;

			await page.evaluate(() => window.scrollTo({ top: 300, behavior: 'instant' }));
			await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThanOrEqual(240);
			await expect.poll(async () => (await network.boundingBox())!.y).toBeLessThan(0);
			// The city row can leave the viewport before WebKit paints the sticky chrome.
			await page.evaluate(
				() =>
					new Promise<void>((resolve) =>
						requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
					),
			);
			expect((await pill.boundingBox())!.y, `${locale} ${width}px sticky pill`).toBeCloseTo(
				pillStart.y,
				0,
			);

			const vacated = await page.evaluate(() => {
				const pr = document.querySelector('[data-testid="nav-pill"]')!.getBoundingClientRect();
				const hit = document.elementFromPoint(window.innerWidth / 2, pr.bottom + 24);
				return {
					hitInMain: Boolean(hit?.closest('main')),
					hitTag: hit ? `${hit.tagName}.${hit.className}` : null,
				};
			});
			expect(vacated.hitInMain, `${locale} ${width}px vacated hit: ${vacated.hitTag}`).toBe(true);

			// Search sheet opens and returns focus without losing scroll position.
			const searchBox = (await search.boundingBox())!;
			await page.mouse.click(searchBox.x + searchBox.width / 2, searchBox.y + searchBox.height / 2);
			await expect(page.getByRole('dialog')).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(page.getByRole('dialog')).toHaveCount(0);
			await expect(search).toBeFocused();

			// Keyboard focus brings the scrolled network row back into view.
			if (browserName === 'chromium') {
				await menu.focus();
				await page.keyboard.press('Tab');
				const city = pill.getByRole('combobox', { name: words.network });
				await expect(city).toBeFocused();
				await expect
					.poll(async () => (await network.boundingBox())!.y)
					.toBeCloseTo(networkStart.y, 0);
			}

			// At 200% text the compact header and city picker fit within the viewport.
			await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
			await page.addStyleTag({ content: 'html { font-size: 200%; }' });
			await page.evaluate(() => document.fonts.ready);
			await expect(search).toBeVisible();
			await expect(network).toBeVisible();
			const zoomedPill = (await pill.boundingBox())!;
			expect(zoomedPill.x, `${locale} ${width}px 200% pill start`).toBeGreaterThanOrEqual(0);
			expect(
				zoomedPill.x + zoomedPill.width,
				`${locale} ${width}px 200% pill end`,
			).toBeLessThanOrEqual(width);
			expect(
				await page.evaluate(() => document.documentElement.scrollWidth),
				`${locale} ${width}px 200% page width`,
			).toBeLessThanOrEqual(width);
		}
	});

	for (const [city, licences] of Object.entries(cities)) {
		test(`${locale} ${city} credits the source and identifies the site as independent`, async ({
			page,
		}) => {
			const agency = agencyByCity[city];
			const disclaimer =
				locale === 'fr'
					? `Site non officiel, sans affiliation avec ${agency}.`
					: `Unofficial website, not affiliated with ${agency}.`;
			for (const href of ['/', '/?frameMode=live', '/map']) {
				await open(page, localizeHref(href, locale, city));
				const footer = page.getByRole('contentinfo');
				await expect(footer.locator('[data-slot="source-credit"]')).toHaveText(licences[locale]);
				await expect(footer.locator('[data-slot="agency-disclaimer"]')).toHaveText(disclaimer);
			}
			await open(page, localizeHref('/privacy', locale, city));
			const legal = page.getByTestId('footer');
			await expect(legal.getByText(taglines[locale], { exact: true })).toBeVisible();
			await expect(legal.locator('[data-slot="agency-disclaimer"]')).toHaveText(disclaimer);
			await expect(legal.locator('[data-slot="source-credit"]')).toHaveCount(0);
			await expect(legal).not.toContainText(licences[locale]);
		});
	}
}

test('the reading rail shares the content gutter and clears the header', async ({ page }) => {
	await page.setViewportSize({ width: 1024, height: 900 });
	await open(page, '/?provider=stm&frameMode=record');
	const frame = page.locator('[data-slot="app-frame"]');
	await expect(frame).toHaveAttribute('data-rail-layout', 'paired');
	for (const width of [1024, 1206, 1280, 1440]) {
		await page.setViewportSize({ width, height: 900 });
		await waitForFrameClearance(page);
		const gaps = await frame.evaluate((element) => {
			const bounds = element.getBoundingClientRect();
			const rail = element.querySelector('[data-slot="surface-rail"]')!.getBoundingClientRect();
			const chrome = element
				.querySelector('[data-slot="app-frame-chrome"]')!
				.getBoundingClientRect();
			const surface = element.querySelector('main [data-slot="surface"]')!;
			return {
				start: rail.left - bounds.left,
				end:
					bounds.right -
					surface.getBoundingClientRect().right +
					parseFloat(getComputedStyle(surface).paddingInlineEnd),
				top: rail.top - chrome.bottom,
			};
		});
		expect(gaps.start, `inline gutter at ${width} px`).toBeCloseTo(gaps.end, 1);
		expect(gaps.top, `top gap at ${width} px`).toBeCloseTo(16, 1);
	}
});

test('desktop controls keep their column and control changes retain focus and scroll', async ({
	page,
	browserName,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await open(page, '/?provider=stm');
	const rail = page.getByRole('complementary', { name: 'Controls', exact: true });
	expect((await rail.boundingBox())!.width).toBe(272);
	const main = page.getByRole('main');
	const x = (await main.boundingBox())!.x;
	if (browserName === 'chromium') {
		const search = page
			.getByTestId('nav-pill')
			.getByRole('combobox', { name: navPillCopy.en.searchAria.all });
		await search.focus();
		await page.keyboard.press('Tab');
		await expect(
			page.getByTestId('nav-pill').getByRole('combobox', { name: navPillCopy.en.network }),
		).toBeFocused();
	}
	const menu = page.getByTestId('nav-menu-toggle');
	await menu.click();
	await page
		.getByRole('dialog', { name: navPillCopy.en.menu })
		.locator('[data-slot="menu-group"]')
		.getByRole('link', { name: 'Lines', exact: true })
		.click();
	await expect(page).toHaveURL(/\/lines\?/);
	await expect(main).toBeFocused();
	expect(await page.evaluate(() => window.scrollY)).toBe(0);
	expect((await main.boundingBox())!.x).toBe(x);

	await expect(rail.getByRole('radio', { name: 'Live now', exact: true })).toBeDisabled();
	const record = rail.getByRole('radio', { name: 'Record', exact: true });
	await expect(record).toBeDisabled();
	await expect(record).toBeChecked();
	await expect(rail.getByText('This screen is a record. It has no live view.')).toBeVisible();
	const cards = await rail
		.locator('[data-slot="controls-rail"]')
		.evaluateAll((elements) => elements.map((element) => getComputedStyle(element).padding));
	expect(new Set(cards).size).toBe(1);
	await expect(rail.getByText('Record starts 13 October 2026.')).toBeVisible();
	const preset = rail.getByRole('radio', { name: '28 days', exact: true });
	const performance = main.getByRole('article', { name: 'Every measured line', exact: true });
	const firstLine = performance.getByRole('row', { name: /Sherbrooke/ });
	const position = () =>
		performance.evaluate((section) => ({
			scroll: window.scrollY,
			headingTop: section.querySelector('h2')!.getBoundingClientRect().top,
			tableHeaderTop: section.querySelector('thead')!.getBoundingClientRect().top,
		}));
	const trips = firstLine.getByRole('cell', { name: /^90 of 105/ });
	const punctuality = firstLine.getByRole('cell', { name: /^80\.0%/ });
	await expect(trips).toBeVisible();
	await expect(punctuality).toBeVisible();
	await page.evaluate(() => document.fonts.ready);
	await preset.focus();
	await page.evaluate(() => {
		window.scrollTo(0, 250);
		// Deliver the real route data first and hold its streamed answers until the pending check.
		const fetch = window.fetch;
		window.fetch = async (...args) => {
			const response = await fetch(...args);
			if (!response.url.includes('/lines/__data.json?') || !response.url.includes('period=28-days'))
				return response;
			window.fetch = fetch;
			const data = await response.text();
			const firstLineEnd = data.indexOf('\n') + 1;
			const encoder = new TextEncoder();
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(encoder.encode(data.slice(0, firstLineEnd)));
						window.addEventListener(
							'release-lines-answers',
							() => {
								controller.enqueue(encoder.encode(data.slice(firstLineEnd)));
								controller.close();
							},
							{ once: true },
						);
					},
				}),
				{ headers: response.headers, status: response.status },
			);
		};
	});
	const before = await position();
	expect(before.scroll).toBe(250);
	const rowTop = await firstLine.evaluate((row) => row.getBoundingClientRect().top);
	try {
		await page.keyboard.press('Space');
		await expect(page).toHaveURL(/period=28-days/);
		await expect(preset).toBeFocused();
		await expect(
			firstLine.getByRole('cell', { name: 'Calculating…', exact: true }).first(),
		).toBeVisible();
		const pending = performance.locator('p').filter({ hasText: /^Calculating…$/ });
		await expect(pending).toBeVisible();
		expect(
			await pending.evaluate((summary) => {
				const table = summary.closest('article')?.querySelector('table');
				return Boolean(
					table && table.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING,
				);
			}),
		).toBe(true);
		expect(await position(), 'while line readings are pending').toEqual(before);
	} finally {
		await page.evaluate(() => window.dispatchEvent(new Event('release-lines-answers')));
	}
	await expect(trips).toBeVisible();
	await expect(punctuality).toBeVisible();
	await expect(preset).toBeFocused();
	expect(await position(), 'after both readings arrive').toEqual(before);
	expect(await firstLine.evaluate((row) => row.getBoundingClientRect().top)).toBe(rowTop);
	await expect(rail.locator('[data-slot="frame-period-summary"]')).toContainText('28 days');
});

test('phone controls open a sheet and return focus to the pill', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await open(
		page,
		'/fr/lines?provider=stm&period=7-days&recordFrom=2026-11-08&recordTo=2026-11-14',
	);
	const pill = page.getByRole('button', { name: /^Commandes 7 jours.*Ouvrir les commandes/ });
	await expect(pill).toBeVisible();
	expect(
		await pill.evaluate((button) => {
			const { left, width } = button.getBoundingClientRect();
			return left + width / 2 - document.documentElement.clientWidth / 2;
		}),
	).toBeCloseTo(0, 0);
	await pill.focus();
	await page.keyboard.press('Enter');
	const sheet = page.getByRole('dialog', { name: 'Commandes', exact: true });
	await expect(sheet).toBeVisible();
	await expect(sheet.getByRole('radio', { name: 'En direct', exact: true })).toBeDisabled();
	await expect(
		sheet.getByRole('radiogroup', { name: 'Période', exact: true }).getByRole('radio'),
	).toHaveCount(6);
	await expect(sheet.getByRole('radio', { name: '12 mois', exact: true })).toBeVisible();
	await expect(sheet.getByText('Le bilan commence le 13 octobre 2026.')).toBeVisible();
	await expect(sheet.locator('[data-slot="frame-period-summary"]')).toContainText(
		'du 8 au 14 nov. 2026',
	);
	await page.keyboard.press('Escape');
	await expect(sheet).toBeHidden();
	await expect(pill).toBeFocused();
});

test('Live map keeps pinned dates in the address and shows them again in Record', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await open(
		page,
		'/map?provider=stm&frameMode=live&period=7-days&recordFrom=2026-11-08&recordTo=2026-11-14',
	);
	const rail = page.getByRole('complementary', { name: 'Controls', exact: true });
	// Live shows View only: the dates come back with Record.
	await expect(rail.getByText('Period', { exact: true })).toHaveCount(0);
	await expect(rail.getByRole('switch', { name: 'Pause live updates' })).toBeVisible();
	await expect(rail.getByRole('radiogroup', { name: 'Period' })).toHaveCount(0);
	await expect(rail.getByRole('button', { name: 'Choose other dates' })).toHaveCount(0);
	await rail.getByRole('radio', { name: 'Record', exact: true }).click();
	await expect(page).toHaveURL(/mapLayer=stops/);
	await expect(page).toHaveURL(/recordFrom=2026-11-08.*recordTo=2026-11-14/);
	await expect(rail.locator('[data-slot="frame-period-summary"]')).toContainText(
		'8 to 14 Nov 2026',
	);
});

test('the footer, presets and Ottawa city label keep whole words at 200% text', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await open(page, '/?provider=stm');
	await page.addStyleTag({ content: 'html { font-size: 200%; }' });
	await expect(page.locator('[data-slot="app-frame"]')).toHaveAttribute(
		'data-rail-layout',
		'compact',
	);
	await page.evaluate(() => document.fonts.ready);
	expect(
		(await textDefects(page)).filter(
			({ kind, selector }) => kind === 'broken-word' && selector.includes('footer-'),
		),
	).toEqual([]);
	const rail = await openFrameControls(page);
	await expect(rail.getByRole('radio', { name: 'Yesterday', exact: true })).toBeVisible();
	expect(
		(await textDefects(page)).filter(
			({ kind, selector }) => kind === 'broken-word' && selector.includes('segmented-choice'),
		),
	).toEqual([]);
	await open(page, '/fr?provider=stm');
	await page.addStyleTag({ content: 'html { font-size: 200%; }' });
	await expect(page.locator('[data-slot="app-frame"]')).toHaveAttribute(
		'data-rail-layout',
		'compact',
	);
	await page.evaluate(() => document.fonts.ready);
	expect(
		(await textDefects(page)).filter(
			({ kind, selector }) => kind === 'broken-word' && selector.includes('footer-'),
		),
	).toEqual([]);
	expect(await page.getByTestId('footer').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
		true,
	);

	await page.setViewportSize({ width: 390, height: 844 });
	await open(page, '/fr/privacy?provider=octranspo');
	await page.addStyleTag({ content: 'html { font-size: 200%; }' });
	await expect(page.locator('[data-slot="site-header-network"]')).toBeVisible();
	await page.evaluate(() => document.fonts.ready);
	expect(
		(await textDefects(page)).filter(
			({ kind, selector }) => kind === 'broken-word' && selector.includes('network-picker'),
		),
	).toEqual([]);
});

test('the map title and camera controls clear their neighbours at normal and enlarged text', async ({
	page,
}) => {
	await open(page, '/map?provider=stm&frameMode=live');
	await expect(page.getByTestId('map-progressive')).toHaveAttribute(
		'data-map-progressive-state',
		'ready',
	);
	const footer = page.locator('[data-slot="map-source-footer"]');
	await expect(footer).toBeVisible();
	for (const width of [320, 390, 1024, 1440]) {
		await page.setViewportSize({ width, height: 900 });
		for (const scale of [100, 200]) {
			await page.evaluate(
				(value) => (document.documentElement.style.fontSize = value + '%'),
				scale,
			);
			const paired = width >= 1024 && scale === 100;
			await expect(page.locator('[data-slot="app-frame"]')).toHaveAttribute(
				'data-rail-layout',
				paired ? 'paired' : 'compact',
			);
			await expect
				.poll(() =>
					page.evaluate(() => {
						const box = (selector: string) =>
							document.querySelector(selector)!.getBoundingClientRect();
						return {
							aboveFooter:
								box('.map-camera-actions').bottom <= box('[data-slot="map-source-footer"]').top,
							belowChrome: box('.map-head').top >= box('[data-slot="app-frame-chrome"]').bottom - 1,
						};
					}),
				)
				.toEqual({ aboveFooter: true, belowChrome: true });
		}
	}
});

test('the legend clears Controls on compact maps and filters stay inside Controls', async ({
	page,
}) => {
	await open(page, '/map?provider=stm&frameMode=live');
	await expect(page.getByTestId('map-progressive')).toHaveAttribute(
		'data-map-progressive-state',
		'ready',
	);
	const legend = page.getByTestId('map-legend-button');
	const frameControls = page.getByRole('button', { name: /^Controls.*Open controls/ });
	const footer = page.locator('[data-slot="map-source-footer"]');
	await expect(footer).toBeVisible();
	await page.setViewportSize({ width: 390, height: 900 });
	await expect(legend).toBeVisible();
	await expect(frameControls).toBeVisible();
	for (const licence of [true, false]) {
		await footer.evaluate((element, visible) => {
			(element as HTMLElement).hidden = !visible;
		}, licence);
		await expect
			.poll(() =>
				page
					.locator('[data-slot="app-shell"]')
					.evaluate(
						(element) =>
							parseFloat(
								(element as HTMLElement).style.getPropertyValue('--map-source-clearance'),
							) > 0,
					),
			)
			.toBe(licence);
		for (const width of [320, 390, 768, 1023]) {
			await page.setViewportSize({ width, height: 900 });
			for (const scale of [100, 200]) {
				await page.evaluate(
					(percent) => (document.documentElement.style.fontSize = percent + '%'),
					scale,
				);
				await expect
					.poll(async () => {
						const a = await legend.boundingBox();
						const b = await frameControls.boundingBox();
						return !!a && !!b && a.y + a.height <= b.y;
					})
					.toBe(true);
			}
		}
	}
	await page.setViewportSize({ width: 390, height: 900 });
	await page.evaluate(() => (document.documentElement.style.fontSize = '100%'));
	const filters = page.locator('[data-map-filter-trigger]');
	await expect(filters).toBeHidden();
	await frameControls.click();
	await expect(filters).toBeVisible();
});
