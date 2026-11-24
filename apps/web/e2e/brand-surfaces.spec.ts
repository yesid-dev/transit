import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { waitForFrameClearance } from './layout-helpers';
import { SURFACE_NAV } from '../src/lib/content/nav';
import { copy as mapCopy } from '../src/lib/features/map/map.copy';
import { DEFAULT_LOCALE, PUBLISHED_LOCALES } from '../src/lib/i18n/config';
import { captureFleet, captureUrl } from './capture-fixture';

const homeDelays = Array.from({ length: 321 }, (_, i) => (i < 257 ? 0 : 360));

for (const locale of PUBLISHED_LOCALES)
	test(`${locale}: map credits stay immediately above the location control`, async ({ page }) => {
		await page.goto((locale === DEFAULT_LOCALE ? '' : `/${locale}`) + '/map');
		const attribution = page.getByLabel(mapCopy[locale].attributionToggle, { exact: true });
		const location = page.getByRole('button', { name: mapCopy[locale].nearMe, exact: true });
		await expect(attribution).toBeVisible();
		await expect(location).toBeVisible();
		for (const expanded of [false, true]) {
			if (expanded) await attribution.click();
			const credit = (await attribution.locator('..').boundingBox())!,
				fab = (await location.boundingBox())!;
			expect(credit.y + credit.height).toBeLessThanOrEqual(fab.y);
			expect(Math.abs(credit.x + credit.width - fab.x - fab.width)).toBeLessThanOrEqual(1);
			expect(credit.x).toBeGreaterThanOrEqual(0);
		}
		await attribution.focus();
		await attribution.press('Enter');
		await expect(attribution).toBeFocused();
	});

const departures = JSON.parse(readFileSync(new URL('./departures.json', import.meta.url), 'utf8'));
const stop = Object.keys(departures.stops)[0]!;

test.use({ bypassCSP: true });

test.beforeEach(async ({ page }) => {
	await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
});

test('homepage ground follows window scrolling and reverses without moving the trigger', async ({
	page,
}) => {
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await page.goto('/?frameMode=live');
	const props = page.locator('[data-slot="construction-props"]');
	await expect(props).toHaveAttribute('data-state', 'hidden');
	const samples = [];
	let previousProgress = 0;
	let previousScroll = 0;
	for (const fraction of [0.98, 0.825, 0.7, 0.825, 0.98, 0.7]) {
		const requested = await page.locator('.construction-anchor').evaluate((anchor, fraction) => {
			window.scrollBy(0, anchor.getBoundingClientRect().top - innerHeight * fraction);
			return { scroll: window.scrollY, top: anchor.getBoundingClientRect().top };
		}, fraction);
		await expect
			.poll(async () => {
				const progress = Number(await props.getAttribute('data-progress'));
				return (
					samples.length === 0 ||
					Math.sign(requested.scroll - previousScroll) * (progress - previousProgress) > 0
				);
			})
			.toBe(true);
		previousProgress = Number(await props.getAttribute('data-progress'));
		previousScroll = requested.scroll;
		const sample = await page.locator('.construction-anchor').evaluate((anchor) => ({
			top: anchor.getBoundingClientRect().top,
			scroll: window.scrollY,
			height: document.querySelector('.home-construction-floor')!.getBoundingClientRect().height,
		}));
		expect(Math.abs(sample.top - requested.top)).toBeLessThanOrEqual(1);
		expect(Math.abs(sample.scroll - requested.scroll)).toBeLessThanOrEqual(1);
		samples.push(sample);
	}
	expect(samples[2].height).toBeGreaterThan(samples[1].height);
	expect(samples[1].height).toBeGreaterThan(samples[0].height);
	expect(Math.abs(samples[4].height - samples[0].height)).toBeLessThanOrEqual(1);
	expect(
		await page.locator('.home-construction-floor').evaluate((floor) => {
			for (let element: Element | null = floor; element; element = element.parentElement) {
				const { backgroundImage, backgroundColor } = getComputedStyle(element);
				if (
					backgroundImage !== 'none' ||
					(backgroundColor !== 'transparent' && backgroundColor !== 'rgba(0, 0, 0, 0)')
				) {
					return backgroundImage;
				}
			}
			return 'none';
		}),
	).toContain('linear-gradient');
	const root = page.locator('#main');
	await root.focus();
	// Focus scrolls the main into view and hides the ground again.
	await expect(props).toHaveAttribute('data-state', 'hidden');
	await Promise.all([
		page.evaluate(
			() =>
				new Promise<void>((resolve) =>
					window.addEventListener('scrollend', () => resolve(), { once: true }),
				),
		),
		root.press('End'),
	]);
	await expect(props).toHaveAttribute('data-state', 'visible');
	await expect(props).toHaveAttribute('data-progress', '1');
	// Revealing the ground adds document height. Wait for the first native scroll
	// to finish before End targets the new bottom; progress reaches 1 mid-scroll.
	await root.press('End');
	await expect
		.poll(() =>
			page.evaluate(() => document.scrollingElement!.scrollHeight - innerHeight - scrollY),
		)
		.toBeLessThanOrEqual(1);
	const art = await props
		.locator('[data-construction-prop] > svg, [data-construction-fixture] > svg')
		.evaluateAll((elements) =>
			elements
				.map((element) => element.getBoundingClientRect().toJSON())
				.sort((a, b) => a.left - b.left),
		);
	for (let i = 0; i < art.length; i++) {
		expect(art[i].left).toBeGreaterThanOrEqual(0);
		expect(art[i].right).toBeLessThanOrEqual(page.viewportSize()!.width);
		if (i) expect(art[i].left).toBeGreaterThanOrEqual(art[i - 1].right);
	}
	await expect(props.locator('[data-slot="construction-floodlight"]')).toHaveAttribute(
		'data-lit',
		'false',
	);
	await expect(
		page.locator('[data-slot="closer-floodlight"], [data-testid="hero-dot-annotation"]'),
	).toHaveCount(0);
	await page.goto('/lines');
	await expect(props).toHaveCount(0);
	await page.goto('/fr?frameMode=live');
	await expect(props).toHaveCount(1);
});

test('the home cards hold their place while live numbers and rankings arrive', async ({ page }) => {
	// Hold the live and ranking files before the first measurement.
	let release = (): void => {};
	const held = new Promise<void>((resolve) => (release = resolve));
	const generated_utc = new Date().toISOString();
	await page.route(captureUrl, async (route) => {
		await held;
		await route.fulfill({
			json: captureFleet(Date.now(), 'stm', homeDelays),
		});
	});
	await page.route('**/v1/stm/historic/hotspots.json', async (route) => {
		await held;
		await route.fulfill({
			json: {
				generated_utc,
				by_grain: [
					{
						grain: 'week',
						date: '2026-06-08',
						window_end: '2026-06-14',
						entries: [
							{
								id: '24',
								type: 'route',
								rank: 1,
								name: 'Sherbrooke',
								severe_pct: 12.5,
								observation_count: 80,
							},
							{ id: 'S1', type: 'stop', rank: 2, name: 'Fixture stop', severe_pct: 9.1 },
						],
					},
				],
			},
		});
	});
	await page.route('**/v1/stm/historic/route_reliability/index.json', async (route) => {
		await held;
		await route.fulfill({
			json: {
				generated_utc,
				route_ids: ['24'],
				weekly_stops: [
					{
						id: 'S1',
						name: 'Fixture stop',
						state: 'ranked',
						rank: 1,
						numerator: 100,
						denominator: 110,
						pct: 91,
						severe_pct: 9.1,
						window_start: '2026-06-08',
						window_end: '2026-06-14',
					},
				],
			},
		});
	});
	await page.goto('/?frameMode=live&recordFrom=2026-11-08&recordTo=2026-11-14');
	const strip = page.locator('[data-slot="home-pulse"]');
	const below = page.locator('[data-slot="home-groups"]');
	const documentTop = () =>
		below.evaluate((element) => element.getBoundingClientRect().top + window.scrollY);
	await expect(strip.locator('[data-slot="home-record"]')).toContainText(
		'81.2% of observed stop events were on time',
	);
	await expect(strip.locator('[data-live]')).toHaveCount(2);
	await waitForFrameClearance(page);
	const before = await documentTop();
	release();
	await expect(strip.locator('[data-live="reporting"]')).toContainText('321');
	await expect(strip.getByRole('link', { name: /Sherbrooke/ })).toBeVisible();
	await expect(strip.getByRole('link', { name: /Fixture stop/ })).toBeVisible();
	expect(Math.abs((await documentTop()) - before)).toBeLessThanOrEqual(1);
});

test('the home cards hold their place when the live numbers cannot be loaded', async ({ page }) => {
	// French on the narrowest phone: the longest message in the least room.
	await page.setViewportSize({ width: 320, height: 800 });
	let release = (): void => {};
	const held = new Promise<void>((resolve) => (release = resolve));
	await page.route(captureUrl, async (route) => {
		await held;
		await route.fulfill({ status: 404, json: {} });
	});
	await page.goto('/fr?frameMode=live');
	const strip = page.locator('[data-slot="home-pulse"]');
	const below = page.locator('[data-slot="home-groups"]');
	const documentTop = () =>
		below.evaluate((element) => element.getBoundingClientRect().top + window.scrollY);
	await expect(strip.locator('[data-live]')).toHaveCount(2);
	await waitForFrameClearance(page);
	const before = await documentTop();
	release();
	await expect(strip.getByText('Chiffres en direct indisponibles')).toBeVisible();
	expect(Math.abs((await documentTop()) - before)).toBeLessThanOrEqual(1);
});

test('the home cards hold their place while Refresh runs, succeeds and fails', async ({ page }) => {
	// Any provider's live file: the result's room must be reserved before the first Refresh.
	let gate: Promise<void> | null = null;
	let fail = false;
	await page.route(captureUrl, async (route) => {
		if (gate) await gate;
		if (fail) return route.fulfill({ status: 503, json: {} });
		await route.fulfill({
			json: captureFleet(
				Date.now(),
				new URL(route.request().url()).searchParams.get('city')!,
				homeDelays,
			),
		});
	});
	const said = {
		en: { refresh: 'Refresh', success: 'Live data updated at', failure: 'Could not refresh.' },
		fr: {
			refresh: 'Actualiser',
			success: 'Données en direct mises à jour à',
			failure: 'Actualisation impossible.',
		},
	} as const;
	for (const width of [320, 390, 1280])
		for (const locale of ['en', 'fr'] as const) {
			gate = null;
			fail = false;
			await page.setViewportSize({ width, height: 900 });
			await page.goto(`${locale === 'fr' ? '/fr' : '/'}?frameMode=live`);
			const live = page.locator('[data-slot="home-pulse-live"]');
			await expect(live.locator('[data-live="reporting"]')).toContainText('321');
			const below = page.locator('[data-slot="home-groups"]');
			const top = () =>
				below.evaluate((element) => element.getBoundingClientRect().top + window.scrollY);
			const before = await top();
			for (const outcome of ['success', 'failure'] as const) {
				const at = `${width}px ${locale} ${outcome}`;
				let release = (): void => {};
				gate = new Promise<void>((resolve) => (release = resolve));
				fail = outcome === 'failure';
				await live.getByRole('button', { name: said[locale].refresh, exact: true }).click();
				expect(Math.abs((await top()) - before), `${at}: pending`).toBeLessThanOrEqual(1);
				release();
				gate = null;
				await expect(live.locator('[aria-live="polite"]')).toContainText(said[locale][outcome]);
				expect(Math.abs((await top()) - before), `${at}: result`).toBeLessThanOrEqual(1);
			}
		}
});

test('the home ranking rows show whole names and hold their place', async ({ page }) => {
	// Ottawa's line 303 (published November 11) and a long Montréal stop: names are never cut.
	const long = {
		line: 'Bayshore / Carlingwood <> Dunrobin / Carp / Stittsville',
		stop: 'École de technologie supérieure (Peel / Notre-Dame)',
	};
	const generated_utc = new Date(Date.now() - 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z');
	let held: Promise<void> = Promise.resolve();
	const hold = (pattern: string, json: unknown) =>
		page.route(pattern, async (route) => {
			await held;
			await route.fulfill({ json });
		});
	await page.route('**/api/schedule-edition?city=stm', (route) =>
		route.fulfill({
			json: {
				schedule: {
					date: generated_utc.slice(0, 10),
					routes: [303, 301, 305].map((n) => ({ id: `${n}`, short: `${n}`, type: 3 })),
					stops: [],
				},
			},
		}),
	);
	await hold('**/historic/hotspots.json', {
		generated_utc,
		by_grain: [
			{
				grain: 'week',
				date: '2026-11-04',
				window_end: '2026-11-10',
				entries: [
					[303, long.line, 85, 173],
					[301, 'Bayshore / Carlingwood <> Richmond / Stittsville', 84.3, 185],
					[305, 'Carlingwood <> North Gower / Manotick', 75.6, 127],
				].map(([id, name, severe_pct, observation_count], i) => ({
					id: `${id}`,
					type: 'route',
					rank: i + 1,
					name,
					severe_pct,
					observation_count,
				})),
			},
		],
	});
	const stop = (id: string, name: string, late: number, readings: number) => ({
		id,
		name,
		state: 'ranked',
		rank: 1,
		numerator: readings - late,
		denominator: readings,
		pct: Math.round((100 * (readings - late)) / readings),
		severe_pct: Math.round((1000 * late) / readings) / 10,
		window_start: '2026-11-04',
		window_end: '2026-11-10',
	});
	await hold('**/historic/route_reliability/index.json', {
		generated_utc,
		route_ids: [],
		weekly_stops: [
			stop('S1', long.stop, 60, 64),
			stop('S2', 'Manotick Main / Currier', 40, 47),
			stop('S3', 'Longfields / Kilspindie', 44, 53),
		],
	});
	for (const width of [320, 390, 1280])
		for (const locale of ['en', 'fr'] as const) {
			const at = `${width}px ${locale}`;
			let release = (): void => {};
			held = new Promise<void>((resolve) => (release = resolve));
			await page.setViewportSize({ width, height: 900 });
			await page.goto(`${locale === 'fr' ? '/fr' : '/'}?frameMode=live`);
			const below = page.locator('[data-slot="home-groups"]');
			const top = () =>
				below.evaluate((element) => element.getBoundingClientRect().top + window.scrollY);
			await expect(page.locator('[data-slot="home-pulse-worst"]')).toBeVisible();
			await waitForFrameClearance(page);
			const before = await top();
			release();
			const rows = page.locator('a.rank-row');
			await expect(rows).toHaveCount(6);
			expect(Math.abs((await top()) - before), `${at}: rows arrive`).toBeLessThanOrEqual(1);
			const names = await rows.evaluateAll((elements) =>
				elements.map((row) => {
					const name = row.querySelector<HTMLElement>('.rank-name')!;
					const value = row.querySelector<HTMLElement>('.rank-value')!.getBoundingClientRect();
					const box = name.getBoundingClientRect();
					const edge = row.getBoundingClientRect();
					return {
						text: name.textContent!.trim(),
						// The name's own content fits its box, and the box sits inside the row, clear of the share.
						fits:
							name.scrollWidth <= name.clientWidth + 1 &&
							name.scrollHeight <= name.clientHeight + 1 &&
							box.left >= edge.left - 1 &&
							box.right <= edge.right + 1 &&
							box.bottom <= edge.bottom + 1 &&
							!(
								box.left < value.right &&
								value.left < box.right &&
								box.top < value.bottom &&
								value.top < box.bottom
							),
					};
				}),
			);
			for (const name of [long.line, long.stop])
				expect(
					names.find((entry) => entry.text === name),
					`${at}: ${name}`,
				).toEqual({ text: name, fits: true });
			expect(
				names.filter((entry) => !entry.fits).map((entry) => entry.text),
				at,
			).toEqual([]);
		}
});

test('homepage props remain static without JavaScript and switch instantly with reduced motion', async ({
	browser,
	baseURL,
	page,
}) => {
	const context = await browser.newContext({
		baseURL,
		viewport: page.viewportSize()!,
		javaScriptEnabled: false,
	});
	try {
		const fallback = await context.newPage();
		await fallback.goto('/?frameMode=live');
		await expect(fallback.locator('[data-slot="construction-props"]')).toHaveAttribute(
			'data-state',
			'static',
		);
		for (const prop of await fallback.locator('[data-construction-prop]').all()) {
			await expect(prop).toBeVisible();
			const box = (await prop.boundingBox())!;
			expect(box.x).toBeGreaterThanOrEqual(0);
			expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
		}
		expect(
			await fallback
				.locator('.home-construction-floor')
				.evaluate((element) => element.getBoundingClientRect().height),
		).toBeGreaterThan(0);
	} finally {
		await context.close();
	}
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.goto('/?frameMode=live');
	const props = page.locator('[data-slot="construction-props"]');
	await expect(props).toHaveAttribute('data-state', 'hidden');
	await page.locator('#main').focus();
	await page.locator('#main').press('End');
	await expect(props).toHaveAttribute('data-state', 'visible');
	const artwork = props.locator('svg');
	// Four props (the sign includes a nested SVG) and the fixture: observe each through
	// CSS matchers rather than one bulk main-world array-handle evaluation.
	await expect(artwork).toHaveCount(6);
	for (let index = 0; index < 6; index++) {
		await expect(artwork.nth(index)).toHaveCSS('animation-name', 'none');
		await expect(artwork.nth(index)).toHaveCSS('transition-duration', '0s');
	}
});

test("a metric's defining SQL is a named, keyboard-reachable region", async ({ page }) => {
	await page.goto('/metrics/archive');
	const sqlCards = '[data-slot="typed-information-card"][data-kind="sql"]';
	const region = page.locator(sqlCards).first().getByRole('region');
	await expect(region).toBeVisible();
	await expect(region).toHaveAccessibleName(/\S/);
	await region.focus();
	await expect(region).toBeFocused();
	await expect(region).toContainText(/SELECT/i);
	const colors = await region.evaluate(
		(pre) =>
			new Set(Array.from(pre.querySelectorAll('span'), (span) => getComputedStyle(span).color))
				.size,
	);
	expect(colors, 'the SQL is syntax-colored').toBeGreaterThan(1);
});

test('the Stop Record header clears the frame and gives its back link a full target', async ({
	page,
}) => {
	await page.goto('/stop/' + stop);
	const main = page.getByRole('main');
	const link = main.getByRole('link', { name: 'All stops', exact: true });
	const title = main.getByRole('heading', { level: 1 });
	await expect(link).toBeVisible();
	await expect(title).toBeVisible();
	await expect(main.locator('[data-slot="article-header"] canvas')).toHaveCount(0);
	await page.evaluate(() => document.fonts.ready);
	const chrome = (await page.locator('[data-slot="app-frame-header"]').boundingBox())!;
	const back = (await link.boundingBox())!;
	const heading = (await title.boundingBox())!;
	expect(back.y).toBeGreaterThanOrEqual(chrome.y + chrome.height);
	expect(back.y + back.height).toBeLessThanOrEqual(heading.y);
	expect(back.height).toBeGreaterThanOrEqual(44);
});

test('listing headers are reading frames: a visible title and no artwork', async ({ page }) => {
	// The Lines and Stops finders were the last expressive listings; both now lead with the title.
	let listings = 0;
	for (const { href } of SURFACE_NAV) {
		await page.goto(href);
		const header = page.locator('[data-slot="blueprint-listing-header"]');
		if (!(await header.count())) continue;
		listings += 1;
		const presentation = await page
			.locator('[data-slot="listing-frame"]')
			.first()
			.getAttribute('data-presentation');
		expect(presentation, href).toBe('reading');
		await expect(header.locator('h1')).toBeVisible();
		await expect(header.locator('[data-slot="blueprint-listing-art"]')).toHaveCount(0);
	}
	expect(listings).toBeGreaterThanOrEqual(1);

	await page.goto('/lines');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lines');
	await expect(page.locator('[data-slot="blueprint-listing-art"]')).toHaveCount(0);
});
