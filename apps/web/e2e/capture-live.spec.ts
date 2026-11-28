import { expect, test } from '@playwright/test';
import { alertFixtures } from './alert-fixture.mjs';
import {
	captureFixture,
	captureUrl,
	captureVehicle,
	refreshAlertsCapture,
} from './capture-fixture';

test('the Transit1 live vehicle reads the capture snapshot in English and French', async ({
	page,
}) => {
	const legacyRequests: string[] = [];
	page.on('request', (request) => {
		const { pathname } = new URL(request.url());
		if (/^(?:\/data)?\/v1\//.test(pathname)) legacyRequests.push(pathname);
	});
	for (const lang of ['en', 'fr']) {
		const response = page.waitForResponse((reply) => {
			const url = new URL(reply.url());
			return url.pathname === '/api/live' && url.searchParams.get('city') === 'stm' && reply.ok();
		});
		await page.goto(`${lang === 'fr' ? '/fr' : ''}/vehicle/40061?provider=stm&frameMode=live`);
		await response;
		const main = page.getByRole('main');
		await expect(main.getByText(lang === 'fr' ? 'Peu de places' : 'Few seats')).toBeVisible();
		await main
			.getByRole('button', {
				name: lang === 'fr' ? 'Prévisions à ses prochains arrêts' : 'Predictions at its next stops',
			})
			.click();
		await expect(
			page
				.getByRole('dialog')
				.getByText(
					lang === 'fr'
						? 'Ce sont des prévisions, pas des arrivées observées.'
						: 'These are predictions, not observed arrivals.',
				),
		).toBeVisible();
	}
	expect(legacyRequests).toEqual([]);
});

test('Vehicle Live waits for the trip publication to refresh', async ({ page }) => {
	const scoped = /\/api\/live-trips\?city=stm&trip=T1$/;
	let attempts = 0;
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route(scoped, async (route) => {
		if (++attempts > 1) {
			await held;
			return route.continue();
		}
		return route.fulfill({
			status: 503,
			headers: { 'retry-after': '1' },
			json: { state: 'refreshing' },
		});
	});
	const refreshing = page.waitForResponse(
		(response) => scoped.test(response.url()) && response.status() === 503,
	);
	const current = page.waitForResponse((response) => scoped.test(response.url()) && response.ok());
	try {
		await page.goto('/vehicle/40061?provider=stm&frameMode=live');
		await refreshing;
		await page.getByRole('button', { name: 'Predictions at its next stops' }).click();
		await expect(page.getByRole('dialog').getByRole('status')).toHaveText('Loading predictions…');
		await expect(
			page.getByText('No predictions reported for this trip in this window.'),
		).toHaveCount(0);
		release();
		await current;
		await expect(page.getByText('These are predictions, not observed arrivals.')).toBeVisible();
	} finally {
		release();
	}
});

test('Departure Live shows the redirected prediction report and preserves its CSV', async ({
	page,
}) => {
	await page.goto(
		'/fr/trip/departure-without-vehicle?provider=stm&recordFrom=2026-11-08&recordTo=2026-11-14',
	);
	await expect(page).toHaveURL(/\/fr\/departure\//);
	const report = page.getByRole('article', { name: 'Prévisions communiquées' });
	await expect(
		report.getByText('Ce sont des prévisions, pas des arrivées observées.'),
	).toBeVisible();
	await expect(report.getByRole('table')).toBeVisible();
	await expect(
		report.getByRole('link', { name: 'Télécharger toutes les prévisions (CSV)' }),
	).toHaveAttribute('download', 'trip-departure-without-vehicle-all-predictions.csv');
});

test('Live alerts display capture evidence and distinguish unsupported coverage', async ({
	page,
}) => {
	await page.clock.install();
	let hasCapture = true;
	const header = { en: 'Elevator closed for repair', fr: 'Ascenseur fermé pour réparation' };
	await page.route(captureUrl, async (route) => {
		const at = await page.evaluate(() => Date.now());
		const city = new URL(route.request().url()).searchParams.get('city')!;
		const snapshot = captureFixture(at, {
			city,
			alerts: [
				{
					id: 'elevator-closure',
					header,
					description: {},
					url: {},
					cause: null,
					effect: null,
					severity: 'WARNING',
					routes: ['24'],
					stops: ['S1'],
					periods: [[new Date(at - 60_000).toISOString(), new Date(at + 300_000).toISOString()]],
				},
			],
		});
		snapshot.feeds.i3_alerts.captured_at = hasCapture ? new Date(at - 21_000).toISOString() : null;
		snapshot.feeds.i3_alerts.source_at = snapshot.feeds.i3_alerts.captured_at;
		snapshot.feeds.vehicle_positions.captured_at = null;
		return route.fulfill({ json: snapshot });
	});
	for (const locale of ['en', 'fr'] as const) {
		hasCapture = true;
		const fr = locale === 'fr';
		const href = locale === 'fr' ? '/fr/alerts' : '/alerts';
		await page.goto(`${href}?provider=stm&frameMode=live`);
		await refreshAlertsCapture(page);
		await expect(page.getByText(header[locale], { exact: true })).toBeVisible();
		await expect(
			page.getByRole('article', { name: fr ? 'Par effet' : 'By effect', exact: true }),
		).toContainText(
			fr
				? 'La STM ne publie pas l’effet de ses avis.'
				: 'STM does not publish the effect of its notices.',
		);
		const filter = page
			.locator('#alerts-log')
			.getByRole('group', { name: fr ? 'Filtrer' : 'Filter', exact: true });
		await expect(filter.getByRole('combobox')).toHaveCount(2);
		await expect(page.locator('#alerts-log').getByText(/(?:Until|Jusqu’au) /)).toBeVisible();
		const about = page.getByRole('article', {
			name: fr ? 'À propos des chiffres en direct' : 'About live figures',
		});
		await expect(about).toContainText(
			fr
				? 'Les avis en vigueur en ce moment, dans le dernier relevé du flux.'
				: 'Notices in effect at this moment, in the latest feed capture.',
		);
		await expect(about).toContainText(fr ? 'Quand un avis compte' : 'How a notice counts');
		await expect(about).toContainText(
			fr
				? 'Un avis compte quand ce moment se trouve dans une de ses périodes publiées, ou quand la société de transport ne publie aucune période.'
				: 'A notice counts when this moment falls inside one of its published periods, or when the agency gives no period.',
		);
		await expect(about).toContainText(
			fr ? /Avis\s*:\s*il y a [2-5]\d\s+s\./u : /Notices: [2-5]\d\s+s ago\./u,
		);
		hasCapture = false;
		await refreshAlertsCapture(page);
		await expect(about).toContainText(fr ? 'Avis : indisponibles.' : 'Notices: unavailable.');
		await expect(filter).toHaveCount(0);
		await page.goto(`${href}?provider=octranspo&frameMode=live`);
		await expect(
			page
				.getByRole('status')
				.filter({ hasText: locale === 'fr' ? 'Non publié' : 'Not published' }),
		).toBeVisible();
	}
});

test('Live alerts share effect and line filters and exclude future notices from the count', async ({
	page,
}) => {
	await page.clock.install();
	const at = Date.now();
	const start = new Date(at - 60_000).toISOString();
	const future = new Date(at + 86_400_000).toISOString();
	const alerts = alertFixtures(13).map((alert, index) => ({
		...alert,
		periods: [[index === 12 ? future : start, null]],
	}));
	await page.route(captureUrl, (route) =>
		route.fulfill({
			json: captureFixture(at, {
				alerts: [...alerts, { ...alerts[0], id: 'same-notice-as-published-again' }],
			}),
		}),
	);
	await page.goto('/alerts?provider=stm&frameMode=live');
	await refreshAlertsCapture(page);
	const list = page.locator('#alerts-log');
	await expect(list.getByRole('status')).toHaveText('Showing 5 of 12 notices');
	await expect(page.locator('#alerts-window')).toContainText('12 notices are in effect now.');
	await expect(page.locator('#alerts-window')).toContainText(
		'12 notices. STM published them 13 times.',
	);
	await expect(page.locator('#alerts-breakdown')).toContainText('Not stated');
	await expect(page.locator('#alerts-breakdown')).toContainText(
		'Effects are the agency’s own categories, kept as published.',
	);
	const byLine = page.getByRole('article', { name: 'By line', exact: true });
	await expect(byLine.getByRole('table')).toBeVisible();
	await expect(byLine.locator('[data-slot="record-foot-evidence"]')).toHaveText('12 notices');
	await expect(page.locator('html[data-hydrated]')).toBeAttached();
	const filter = list.getByRole('group', { name: 'Filter', exact: true });
	const line = filter.getByRole('combobox', { name: 'Line' });
	await line.fill('Sherbrooke');
	await line.press('ArrowDown');
	await page.getByRole('option', { name: /^24.*Sherbrooke/ }).click();
	const effect = filter.getByRole('combobox', { name: 'Effect' });
	await effect.fill('Detour');
	await effect.press('ArrowDown');
	await page.getByRole('option', { name: 'Detour', exact: true }).click();
	await expect(list.getByRole('status')).toHaveText('Showing 1 of 1 notice');
	await expect(page).toHaveURL(/route=24.*effect=DETOUR/);
	await page.reload();
	await refreshAlertsCapture(page);
	await expect(list.getByRole('status')).toHaveText('Showing 1 of 1 notice');
	await expect(effect).toHaveValue('Detour');

	await page.goto('/fr/alerts?provider=stm&frameMode=live');
	await refreshAlertsCapture(page);
	await expect(page.locator('#alerts-window')).toContainText('12 avis sont en vigueur.');
	await expect(page.locator('#alerts-window')).toContainText(
		'12 avis. La STM les a publiés 13 fois.',
	);
});

test('data health distinguishes an aged capture from an unavailable response', async ({ page }) => {
	await page.clock.install();
	let missing = false;
	await page.route(captureUrl, (route) =>
		missing
			? route.fulfill({ status: 503, json: { state: 'unavailable' } })
			: route.fulfill({ json: captureFixture(Date.now() - 120_000) }),
	);
	await page.goto('/status?provider=stm&frameMode=live');
	await expect(page.locator('html[data-hydrated]')).toBeAttached();
	await page.clock.runFor(21_000);
	await expect(
		// A cell on wide screens, the row's value on a phone.
		page.getByText(/^Late: last received \d+ min ago$/u).first(),
	).toBeVisible();
	missing = true;
	await page.clock.runFor(21_000);
	await expect(page.getByText('No live data', { exact: true }).first()).toBeVisible();
	if (process.env.TRANSIT_E2E_HEALTH_SCREENSHOTS)
		await page.screenshot({
			fullPage: true,
			path: 'test-results/health-evidence/pr21/stm-en-live-failing.png',
		});
});
test('rail detail uses schedule geometry and omits vehicles from a line without live coverage', async ({
	page,
}) => {
	await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
	const now = Date.now();
	await page.route(captureUrl, (route) =>
		route.fulfill({
			json: captureFixture(now, {
				vehicle_positions: [captureVehicle(now, { route_id: '1-373' })],
			}),
		}),
	);
	const scheduleResponse = page.waitForResponse(
		(response) => new URL(response.url()).pathname === '/api/schedule-edition' && response.ok(),
	);
	const shapeResponse = page.waitForResponse((response) => {
		const url = new URL(response.url());
		return (
			url.pathname === '/api/schedule-map' &&
			(url.searchParams.get('lines') ?? '').includes('1-373') &&
			response.ok()
		);
	});
	const snapshotResponse = page.waitForResponse((response) => captureUrl.test(response.url()));
	await page.route('**/api/stops/slim?provider=stm', (route) =>
		route.fulfill({
			json: { generated_utc: new Date(now).toISOString(), stops: [] },
		}),
	);
	const rail = [-73.595, 45.505];
	await page.goto(`/map?provider=stm&mapview=${rail.join(',')},15,0,0`);
	const schedule = await (await scheduleResponse).json();
	expect(schedule.schedule.route_directions['1-373'][0]).not.toHaveProperty('shape');
	const shapes = await (await shapeResponse).json();
	expect(shapes.schedule.route_shapes['1-373'][0].shape.type).toBe('LineString');
	await snapshotResponse;
	await expect(page.getByTestId('map-progressive')).toHaveAttribute(
		'data-map-progressive-state',
		'ready',
	);
	const canvas = page.locator('.maplibregl-canvas');
	await expect
		.poll(async () => {
			await canvas.hover();
			return canvas.evaluate((node) => (node as HTMLElement).style.cursor);
		})
		.toBe('pointer');
	await canvas.click();
	const detail = page.locator('[data-slot="map-detail-overlay"][data-selection-kind="route"]');
	await expect(detail.getByText('No live data', { exact: true })).toBeVisible();
});
