import { expect, type Locator } from '@playwright/test';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { test } from './layout-test';
import { alertFixtures, stmLiveAlertFixtures } from './alert-fixture.mjs';
import {
	captureFixture,
	captureUrl,
	captureVehicle,
	refreshAlertsCapture,
} from './capture-fixture';
import { designPassCases, type Screen } from './design-pass-cases';
import { recordMapFixture } from './map-record-fixture';
import { measureDesignPass, setWidth } from './design-pass-measure';
import { expectDesignPass } from './design-pass-debt';
import { openFrameControls } from './frame-controls';

const time = Date.parse('2026-11-23T16:00:00Z');
const unobstructedCapture = '[data-slot="app-frame-chrome"] { visibility: hidden !important; }';
const cohesionScreens = new Set<Screen>([
	'alerts',
	'alerts-live',
	'overview',
	'overview-live',
	'lines',
	'stops',
	'line-record',
	'line-live',
	'stop-record',
	'vehicle-record',
	'vehicle-live',
	'departure',
	'daily',
	'network-health',
	'network-health-live',
	'data-health',
	'data-health-live',
	'how-we-measure',
	'download',
	'search',
	'search-query',
	'roadmap',
]);

async function expectFilterPlaceholder(
	filter: Locator,
	label: string,
	placeholder: string,
	width: number,
) {
	await expect(filter.getByText(label, { exact: true })).toBeVisible();
	const input = filter.getByRole('combobox', { name: label, exact: true });
	await expect(input).toHaveAttribute('placeholder', placeholder);
	const { required, available } = await input.evaluate((element: HTMLInputElement) => {
		const style = getComputedStyle(element);
		const context = document.createElement('canvas').getContext('2d')!;
		context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
		context.letterSpacing = style.letterSpacing === 'normal' ? '0px' : style.letterSpacing;
		return {
			required: context.measureText(element.placeholder).width,
			available:
				element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
		};
	});
	expect(required, `${label} placeholder at ${width}px`).toBeLessThanOrEqual(available);
}

test('stops French filter placeholder fits the rail and sheet @layout', async ({ page }) => {
	await page.goto('/fr/stops?provider=stm');
	for (const width of [1440, 1024, 390]) {
		await setWidth(page, width);
		const rail = await openFrameControls(page, 'fr');
		await page.evaluate(() => document.fonts.ready);
		await expectFilterPlaceholder(
			rail.getByRole('group', { name: 'Filtrer', exact: true }),
			'Ligne',
			'Toutes',
			width,
		);
	}
});

test('alerts French filter placeholders fit the rail and sheet @layout', async ({ page }) => {
	await page.setExtraHTTPHeaders({ 'x-transit-fixture-scope': 'alerts' });
	await page.emulateMedia({ colorScheme: 'dark' });
	await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
	await page.clock.install({ time });
	await setWidth(page, 1440);
	await page.route(captureUrl, (route) =>
		route.fulfill({
			json: captureFixture(time, {
				alerts: alertFixtures(12).map((alert) => ({ ...alert, periods: [] })),
			}),
		}),
	);
	await page.goto('/fr/alerts?provider=stm&frameMode=live');
	await refreshAlertsCapture(page);
	const effects = page.locator('#alerts-breakdown dl');
	await expect(effects.locator('dt')).toHaveCount(5);
	const rows = await effects.locator('dt').evaluateAll((labels) => {
		const top = labels[0].getBoundingClientRect().top;
		return labels.filter((label) => label.getBoundingClientRect().top === top).length;
	});
	expect(rows).toBe(4);
	await expect(effects.locator('[data-slot="separator"]')).toHaveCount(0);

	for (const width of [1440, 1024, 390]) {
		await setWidth(page, width);
		const rail = await openFrameControls(page, 'fr');
		const filter = rail.getByRole('group', { name: 'Filtrer', exact: true });
		if (width === 390)
			await expect(
				page.getByRole('dialog', { name: 'Commandes' }).locator('input').first(),
			).toBeVisible();
		await page.evaluate(() => document.fonts.ready);
		for (const [label, placeholder] of [
			['Ligne', 'Toutes'],
			['Arrêt', 'Tous'],
			['Effet', 'Tous'],
		]) {
			await expectFilterPlaceholder(filter, label, placeholder, width);
		}
	}
});

for (const { screen, provider, locale, key, href } of designPassCases) {
	test(`${screen} ${provider} ${locale} @layout`, async ({ page }, info) => {
		const health = screen.startsWith('network-health') || screen.startsWith('data-health');
		const alerts = screen === 'alerts' || screen === 'alerts-live';
		if (alerts) await page.setExtraHTTPHeaders({ 'x-transit-fixture-scope': 'alerts' });
		if (screen === 'stops') await page.setExtraHTTPHeaders({ 'x-transit-fixture-scope': 'stops' });
		await setWidth(page, 1440);
		const liveAlerts = screen === 'alerts-live' && provider === 'stm';
		if (liveAlerts) await page.clock.install({ time });
		else if (screen !== 'line-live' && !(health && screen.endsWith('-live')))
			await page.clock.setFixedTime(time);
		await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
		await page.route(captureUrl, (route) => {
			const city = new URL(route.request().url()).searchParams.get('city')!;
			return route.fulfill({
				json: captureFixture(time, {
					city,
					vehicle_positions: [captureVehicle(time)],
					...(screen === 'alerts-live'
						? {
								alerts: stmLiveAlertFixtures(time),
							}
						: {}),
				}),
			});
		});
		if (screen.startsWith('map-record')) await recordMapFixture(page);
		const response = await page.goto(href);
		expect(response?.status(), href).toBe(screen === 'error' ? 404 : 200);
		await expect(page.locator('html')).toHaveAttribute('lang', locale);
		await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
		if (liveAlerts) await refreshAlertsCapture(page);
		await expect(page.getByRole('main')).toBeVisible();
		if (screen === 'how-we-measure') {
			await expect(page.locator('[data-record-disclosure]').first()).toBeVisible();
		}
		if (screen.startsWith('overview')) {
			await expect(page.locator('[data-slot="record-ranking"] tbody tr')).toHaveCount(6);
			await expect(page.locator('[data-slot="chart-line-series"]')).toBeVisible();
		}
		if (health) {
			await expect(page.locator('[data-slot="record-card"]').first()).toBeVisible();
		}
		if (screen === 'stop-record') {
			await expect(page.locator('[data-slot="hour-grid"]')).toBeVisible();
			await expect(
				page.locator('#daily [data-slot="chart-line-series"][data-reference]'),
			).toBeAttached();
		}
		if (screen === 'download') {
			await expect(page.locator('[data-slot="record-card"]').first()).toBeVisible();
		}
		if (screen === 'search-query') {
			await expect(
				page
					.getByRole('main')
					.getByRole('link', { name: /Sherbrooke/ })
					.first(),
			).toBeVisible();
		}
		if (screen === 'lines') {
			await expect(page.locator('#line-performance tbody tr')).toHaveCount(20);
			const [measured, scheduleOnly, excluded] = await Promise.all([
				page.locator('#line-performance').getByRole('article').boundingBox(),
				page.locator('#lines-without-live-data').getByRole('article').boundingBox(),
				page
					.getByRole('article', {
						name: /^(Lines that cannot be judged on these dates|Lignes impossibles à évaluer pour ces dates)$/,
					})
					.boundingBox(),
			]);
			if (!measured || !scheduleOnly || !excluded)
				throw new Error('Expected all three Lines cards');
			expect([scheduleOnly.x, scheduleOnly.width]).toEqual([measured.x, measured.width]);
			expect([excluded.x, excluded.width]).toEqual([measured.x, measured.width]);
			expect(scheduleOnly.y).toBeGreaterThanOrEqual(measured.y + measured.height);
			expect(excluded.y).toBeGreaterThanOrEqual(scheduleOnly.y + scheduleOnly.height);
		}
		if (screen === 'stops') await expect(page.locator('#stop-results tbody tr')).toHaveCount(20);
		if (screen.startsWith('map-')) {
			// The app exposes the live map and makes the poster inert at this handoff.
			// Later source updates can make MapLibre's loaded() false again.
			await expect(page.locator('[data-map-progressive-state]')).toHaveAttribute(
				'data-map-progressive-state',
				'ready',
			);
			if (screen.startsWith('map-record')) {
				await expect(
					page.getByRole('main').getByRole('searchbox', {
						name: /^(Find a (stop|segment)|Trouver un (arrêt|segment))$/,
					}),
				).toBeVisible();
			}
		}
		if (alerts && provider === 'stm')
			await expect(page.locator('[data-slot="show-more"]').first()).toBeVisible();
		const start = performance.now();
		const redesignedDetail =
			screen === 'departure' ||
			screen === 'vehicle-record' ||
			screen === 'vehicle-live' ||
			screen === 'daily' ||
			screen === 'line-live';
		if (redesignedDetail)
			await expect(
				page.locator('[data-slot="screen-answer"] [data-slot="answer-lead"]'),
			).toBeVisible();
		if (
			screen === 'roadmap' ||
			screen === 'privacy' ||
			screen === 'terms' ||
			screen === 'accessibility'
		) {
			await expect(
				page.locator('[data-slot="surface-rail"], [data-slot="surface-rail-mobile"]'),
			).toHaveCount(0);
		}
		if (cohesionScreens.has(screen)) {
			const layout = page.locator('main [data-record-screen]');
			await expect.soft(layout).toHaveCount(1);
			const groups = layout.locator('[data-page-section-edges]');
			const boundaries = layout.locator('[data-slot="page-section-boundary"]');
			await expect.soft(boundaries).toHaveCount((await groups.count()) - 1);
			await expect.soft(groups.last()).toHaveCSS('padding-bottom', '0px');
			expect
				.soft(
					await layout
						.locator('[data-page-section-edges], [data-slot="page-section-boundary"]')
						.last()
						.getAttribute('data-slot'),
				)
				.toBe('page-section');
			await expect.soft(layout.locator('table .hand-drawn-line')).toHaveCount(0);
			if (alerts)
				await expect.soft(layout.locator('[data-slot="card"] [data-slot="card"]')).toHaveCount(0);
			const plainControlCards = await layout
				.locator(
					'[data-slot="card"]:not([data-interactive]):has(a[href], button, input, select, summary)',
				)
				.evaluateAll((cards) =>
					cards.map((card) => card.querySelector('h2,h3')?.textContent?.trim()),
				);
			expect
				.soft(plainControlCards, 'Cards with an action require the kit interactive treatment')
				.toEqual([]);
		}
		// Adopted Overview checks the actual indicator. Existing debt fingerprints count outlines.
		const { report, focusSequences } = await measureDesignPass(page, {
			countShadowRings:
				health ||
				redesignedDetail ||
				alerts ||
				screen.startsWith('overview') ||
				screen === 'stop-record' ||
				screen === 'how-we-measure' ||
				screen === 'download' ||
				screen === 'roadmap' ||
				screen.startsWith('search') ||
				screen === 'line-record' ||
				screen === 'lines' ||
				screen === 'stops',
		});
		await info.attach('design-pass-measurements', {
			body: JSON.stringify({
				key,
				ms: Math.round(performance.now() - start),
				report,
				focusSequences,
			}),
			contentType: 'application/json',
		});
		const seconds =
			screen === 'how-we-measure' || screen === 'alerts-live'
				? String.raw`(?<!\b90 )(?:seconds|secondes)`
				: 'seconds|secondes';
		const machineUnits = new RegExp(
			String.raw`\b(?:\d+ s (?:late|early)|${seconds}|\d+\s+(?:second|seconde))\b|\b\d{2}:\d{2}:\d{2} ·|\bDirection [01]\b`,
			'i',
		);
		await expect(page.getByRole('main')).not.toContainText(machineUnits);
		if (
			alerts ||
			cohesionScreens.has(screen) ||
			screen === 'privacy' ||
			screen === 'terms' ||
			screen === 'accessibility'
		) {
			for (const theme of ['light', 'dark'] as const) {
				const packetEvidence = process.env.TRANSIT_COHESION_B_EVIDENCE;
				const evidence = packetEvidence ?? process.env.TRANSIT_COHESION_EVIDENCE;
				const capture =
					evidence &&
					(packetEvidence ||
						(provider === 'stm' &&
							(locale === 'en' || screen.startsWith('overview') || screen.startsWith('line-'))));
				const desktopLight = packetEvidence
					? provider === 'stm' && locale === 'en'
					: locale === 'en';
				const width = desktopLight === (theme === 'light') ? 1440 : 390;
				if (capture) await setWidth(page, width);
				await page.evaluate((theme) => localStorage.setItem('theme', theme), theme);
				await page.reload();
				await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
				if (liveAlerts) {
					await refreshAlertsCapture(page);
					await expect(page.locator('#alerts-log [data-slot="show-more"]')).toBeVisible();
				}
				if (alerts) {
					await expect(
						page.locator('[data-slot="screen-answer"], [data-slot="screen-state"]').first(),
					).toBeVisible();
				}
				if (screen === 'search-query') {
					await expect(
						page
							.getByRole('main')
							.getByRole('link', { name: /Sherbrooke/ })
							.first(),
					).toBeVisible();
				}
				if (capture) {
					const heading = page.getByRole('main').getByRole('heading', { level: 1 });
					await expect(heading).toBeVisible();
					await page.screenshot({
						path: join(
							evidence,
							`${screen}-${packetEvidence ? `${provider}-` : ''}${locale}-${width}-${theme}.png`,
						),
						fullPage: true,
					});
					if (!packetEvidence && screen === 'overview' && locale === 'en') {
						await page.locator('[data-slot="footer"]').screenshot({
							path: join(evidence, `footer-${width}.png`),
							style: unobstructedCapture,
						});
					}
				}
				const { violations } = await new AxeBuilder({ page })
					.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
					.analyze();
				expect(
					violations.map(({ id, nodes }) => ({ id, targets: nodes.map(({ target }) => target) })),
					theme,
				).toEqual([]);
			}
		}
		expectDesignPass(screen, key, report);
	});
}

test('Overview card edge responds to hover and keyboard focus', async ({ page }) => {
	const overview = designPassCases.find(({ key }) => key === 'overview/stm/en')!;
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await page.goto(overview.href);
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
	const link = page.getByRole('link', { name: 'Read the full record of the network' });
	const card = link.locator('xpath=ancestor::*[@data-slot="card"][1]');
	await expect(card).toHaveAttribute('data-interactive', 'true');
	const evidence = process.env.TRANSIT_COHESION_EVIDENCE;

	await link.hover();
	await expect(card).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, -1)');
	if (evidence)
		await card.screenshot({ path: join(evidence, 'card-hover.png'), style: unobstructedCapture });

	await page.mouse.move(0, 0);
	await page.keyboard.press('Tab');
	await link.focus();
	await expect(link).toBeFocused();
	expect(await link.evaluate((element) => element.matches(':focus-visible'))).toBe(true);
	await expect(card).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, -1)');
	if (evidence)
		await card.screenshot({
			path: join(evidence, 'card-keyboard-focus.png'),
			style: unobstructedCapture,
		});

	const menu = page.getByTestId('nav-menu-toggle');
	await page.evaluate(() => window.scrollTo(0, 0));
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await menu.click();
	await expect(menu).toHaveAttribute('aria-expanded', 'true');
	if (evidence) {
		await page.screenshot({ path: join(evidence, 'menu-open-1440.png'), animations: 'disabled' });
	}
	await page.keyboard.press('Escape');
	await expect(menu).toBeFocused();
});
