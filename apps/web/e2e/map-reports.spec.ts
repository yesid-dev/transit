import { closeMapInView, openMapControls, openMapInView } from './map-frame-controls';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import {
	expectAccessible,
	expectNoHorizontalOverflow,
	expectTapTargets,
} from '@yesid/config/playwright';
import { copy as reportsCopy } from '../src/lib/features/map/mapReports.copy';
import { MAP_REPORT_CSV_COLUMNS } from '../src/lib/features/map/mapReportsCsv';
import { PUBLISHED_LOCALES } from '../src/lib/i18n/config';
import { localizeHref } from '../src/lib/i18n/routing';
import { SURFACE_NAV } from '../src/lib/content/nav';
import { captureFixture, captureUrl, captureVehicle } from './capture-fixture';

const map = SURFACE_NAV.find((item) => item.key === 'map')!.href;
const GENERATED = '2026-06-15T12:00:00Z';

// A small, deliberate fleet: two recent late positions, one older late position, one on time,
// one early without an observation timestamp, and one offscreen.
const fleet = (overrides: { generated_utc?: string; extraLate?: boolean } = {}) => ({
	generated_utc: overrides.generated_utc ?? GENERATED,
	vehicles: [
		{
			id: 'west-late',
			lat: 45.55,
			lon: -73.9,
			status: 'late',
			delay_min: 9,
			route: '24',
			trip: 't1',
			next_stop: 's1',
			reported_utc: '2026-06-15T11:59:40Z',
			updated_utc: '2026-06-15T11:59:45Z',
			occupancy: 'many_seats',
		},
		{
			id: 'center-late',
			lat: 45.53,
			lon: -73.65,
			status: 'late',
			delay_min: 6,
			route: '55',
			trip: 't2',
			next_stop: 's2',
			reported_utc: '2026-06-15T11:59:50Z',
			updated_utc: '2026-06-15T11:59:50Z',
		},
		{
			id: 'east-ontime',
			lat: 45.48,
			lon: -73.55,
			status: 'on_time',
			delay_min: 0,
			route: '55',
			trip: 't3',
			updated_utc: '2026-06-15T11:59:30Z',
		},
		{
			id: 'old-late',
			lat: 45.5,
			lon: -73.6,
			status: 'late',
			delay_min: 7,
			route: '24',
			trip: 't4',
			reported_utc: '2026-06-15T11:54:00Z',
			updated_utc: '2026-06-15T11:54:00Z',
		},
		{
			id: 'early-fallback',
			lat: 45.51,
			lon: -73.7,
			status: 'early',
			delay_min: -2,
			route: '55',
			trip: 't5',
			updated_utc: '2026-06-15T11:59:20Z',
		},
		{
			id: 'offscreen',
			lat: 45.4,
			lon: -75.7,
			status: 'late',
			delay_min: 6,
			route: '24',
			trip: 't6',
			updated_utc: '2026-06-15T11:59:20Z',
		},
		...(overrides.extraLate
			? [
					{
						id: 'new-late',
						lat: 45.52,
						lon: -73.62,
						status: 'late',
						delay_min: 8,
						route: '55',
						trip: 't8',
						updated_utc: '2026-06-15T11:59:55Z',
					},
				]
			: []),
	],
});

test.use({ bypassCSP: true });

test.beforeEach(async ({ context, page, browserName }) => {
	if (browserName === 'chromium') {
		await context.grantPermissions(['clipboard-read', 'clipboard-write']);
		return;
	}
	// WebKit does not expose Playwright's clipboard permission override.
	await page.addInitScript(() => {
		Object.defineProperty(navigator, 'clipboard', {
			value: {
				async writeText(text: string) {
					sessionStorage.setItem('map-test:clipboard', text);
				},
				async readText() {
					return sessionStorage.getItem('map-test:clipboard') ?? '';
				},
			},
		});
	});
});

type FleetFile = {
	generated_utc: string;
	vehicles: {
		id: string;
		lat: number;
		lon: number;
		delay_min: number;
		route?: string;
		trip?: string;
		next_stop?: string;
		reported_utc?: string;
		occupancy?: string;
	}[];
};

function fleetCapture(file: FleetFile, city: string) {
	const at = Date.parse(file.generated_utc);
	const snapshot = captureFixture(at, {
		city,
		vehicle_positions: file.vehicles.map((row) =>
			captureVehicle(at, {
				vehicle_id: row.id,
				latitude: row.lat,
				longitude: row.lon,
				route_id: row.route ?? null,
				trip_id: row.trip ?? null,
				stop_id: row.next_stop ?? null,
				observed_at: row.reported_utc ?? null,
				delay: row.delay_min * 60,
				occupancy: row.occupancy === 'many_seats' ? 1 : null,
			}),
		),
	});
	for (const feed of Object.values(snapshot.feeds)) {
		feed.captured_at = file.generated_utc;
		feed.source_at = file.generated_utc;
	}
	return snapshot;
}

async function serveFleet(page: Page, current: () => FleetFile) {
	await page.route(captureUrl, (route) => {
		const city = new URL(route.request().url()).searchParams.get('city')!;
		return route.fulfill({ json: fleetCapture(current(), city) });
	});
}

/** Minimal RFC 4180 reader for the downloaded bytes. */
function parseCsv(csv: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = '';
	let quoted = false;
	for (let i = 0; i < csv.length; i += 1) {
		const char = csv[i];
		if (quoted) {
			if (char === '"' && csv[i + 1] === '"') {
				cell += '"';
				i += 1;
			} else if (char === '"') quoted = false;
			else cell += char;
		} else if (char === '"') quoted = true;
		else if (char === ',') {
			row.push(cell);
			cell = '';
		} else if (char === '\r' && csv[i + 1] === '\n') {
			row.push(cell);
			rows.push(row);
			row = [];
			cell = '';
			i += 1;
		} else cell += char;
	}
	if (cell.length > 0 || row.length > 0) {
		row.push(cell);
		rows.push(row);
	}
	return rows;
}

async function openReports(page: Page) {
	await openMapInView(page);
	const panel = page.locator('[data-slot="map-in-view"]');
	await expect(panel).toBeVisible();
	return panel;
}

const downloadAction = /^(Download|T\u00e9l\u00e9charger)$/;
async function rendererCamera(page: Page): Promise<number[]> {
	return (await rendererTransform(page)).slice(4, 9).map(Number);
}

async function rendererTransform(page: Page): Promise<string[]> {
	return page.locator('[data-slot="vehicle-overlay"]').evaluate((canvas) => {
		const receipt = Reflect.get(canvas, Symbol.for('transit.map.vehicleOverlayReceipt'));
		if (!receipt?.drawable) return [];
		return String(receipt.transform).split('|');
	});
}

function expectSameRendererGeometry(actual: string[], expected: string[]): void {
	expect(actual).toHaveLength(15);
	expect(expected).toHaveLength(15);
	expect(actual.slice(0, 4)).toEqual(expected.slice(0, 4));
	for (let i = 4; i < 15; i++) expect(Number(actual[i])).toBeCloseTo(Number(expected[i]), 12);
}

async function expectFocusedTargetUncovered(page: Page): Promise<void> {
	await expect
		.poll(() =>
			page.evaluate(() => {
				const target = document.activeElement;
				if (!(target instanceof HTMLElement) || target.closest('[inert]')) return false;
				const box = target.getBoundingClientRect();
				if (
					box.width <= 0 ||
					box.height <= 0 ||
					box.left < 0 ||
					box.top < 0 ||
					box.right > innerWidth ||
					box.bottom > innerHeight
				)
					return false;
				const xs = [
					box.left + Math.min(8, box.width / 4),
					box.left + box.width / 2,
					box.right - Math.min(8, box.width / 4),
				];
				const ys = [
					box.top + Math.min(8, box.height / 4),
					box.top + box.height / 2,
					box.bottom - Math.min(8, box.height / 4),
				];
				return xs.every((x) =>
					ys.every((y) => {
						const hit = document.elementFromPoint(x, y);
						return hit === target || (hit != null && target.contains(hit));
					}),
				);
			}),
		)
		.toBe(true);
}

for (const locale of PUBLISHED_LOCALES) {
	test(`${locale}: a copied non-default camera survives reports, resize and reload with real rotated geometry`, async ({
		page,
	}) => {
		await page.clock.install({ time: Date.parse(GENERATED) + 30_000 });
		await serveFleet(page, () => fleet());
		const hint = [-73.65, 45.53, 12, 35, 20];
		await page.goto(
			`${localizeHref(map, locale)}?provider=stm&status=late&mapview=${hint.join(',')}`,
		);
		const t = reportsCopy[locale];
		const panel = await openReports(page);
		await expect.poll(() => rendererCamera(page)).toEqual(hint);
		const downloaded = parseCsv((await downloadCsv(page)).bytes);
		const header = downloaded[0];
		// Fixed fixture oracles for the three owning project viewports. The old report
		// is outside the smaller rotated views, rather than removed because of its age.
		// These memberships were also checked against the actual renderer projection
		// in the e2e build; the ordinary production build exposes no camera probe.
		const memberships: Record<string, string[]> = {
			'390x844': ['center-late'],
			'768x1024': ['center-late'],
			'1440x900': ['center-late', 'old-late'],
		};
		const viewport = page.viewportSize()!;
		const expectedIds = memberships[`${viewport.width}x${viewport.height}`];
		expect(expectedIds, 'an explicit fixture geometry oracle for this viewport').toBeDefined();
		expect(downloaded.slice(1).map((row) => row[header.indexOf('vehicle_id')])).toEqual(
			expectedIds,
		);
		expect(
			await panel
				.locator('[data-report-row]')
				.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-report-id'))),
		).toEqual(
			// The list puts the larger delay first, while the CSV keeps the source order.
			viewport.width === 1440 ? ['old-late', 'center-late'] : expectedIds,
		);
		for (const row of downloaded.slice(1)) {
			expect(
				['view_center_lon', 'view_center_lat', 'view_zoom', 'view_bearing', 'view_pitch'].map(
					(key) => Number(row[header.indexOf(key)]),
				),
			).toEqual(hint);
		}
		const size = page.viewportSize()!;
		await page.setViewportSize({ width: size.width + 80, height: size.height - 64 });
		await expect.poll(() => rendererCamera(page)).toEqual(hint);
		// Compare with the resized surface that owns the renderer. The frame also holds the title panel.
		const mapHeight = await page
			.locator('.map-surface')
			.evaluate((surface) => surface.clientHeight);
		await expect
			.poll(async () => (await rendererTransform(page)).slice(2, 4))
			.toEqual([`${size.width + 80}px`, `${mapHeight}px`]);
		await panel.getByRole('button', { name: t.copyLiveView }).click();
		const copied = await page.evaluate(() => navigator.clipboard.readText());
		expect(new URL(copied).searchParams.get('mapview')?.split(',').map(Number)).toEqual(hint);
		const referenceTransform = await rendererTransform(page);
		await page.goto(copied);
		await openReports(page);
		await expect.poll(() => rendererCamera(page)).toEqual(hint);
		// The production renderer receipt includes physical/CSS dimensions, centre,
		// zoom, all three rotations, field of view and all four padding edges.
		expectSameRendererGeometry(await rendererTransform(page), referenceTransform);
	});

	test(`${locale}: normal phone switching transfers focus to uncovered controls in both directions`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.clock.install({ time: Date.parse(GENERATED) + 30_000 });
		await serveFleet(page, () => fleet());
		await page.goto(`${localizeHref(map, locale)}?provider=stm`);
		await expect(page.getByTestId('map-progressive')).toHaveAttribute(
			'data-map-progressive-state',
			'ready',
		);
		const trigger = page.locator('.map-in-view-button');
		await trigger.press('Enter');
		const sheet = page.locator('[data-map-in-view-sheet]');
		await expect(sheet).toBeVisible();
		await page.keyboard.press('Tab');
		await expectFocusedTargetUncovered(page);
		expect(
			await page.evaluate(() =>
				Boolean(document.activeElement?.closest('[data-map-in-view-sheet]')),
			),
		).toBe(true);
		await page.keyboard.press('Escape');
		await expect(sheet).toBeHidden();
		await expect(trigger).toBeFocused();
		await expectFocusedTargetUncovered(page);
	});
}
const networkFixtures = JSON.parse(
	readFileSync(new URL('./providers.json', import.meta.url), 'utf8'),
);
for (const provider of ['stm', 'octranspo'])
	for (const locale of PUBLISHED_LOCALES) {
		test.describe(`${provider} ${locale}: provider-specific map reports`, () => {
			const published = networkFixtures.providers.find(
				(row: { id: string }) => row.id === provider,
			);
			if (!published) throw new Error('published provider fixture required');
			const [west, south, east, north] = published.fit_bounds as number[];
			const lon = (west + east) / 2,
				lat = (south + north) / 2;
			const file = {
				generated_utc: GENERATED,
				vehicles: [
					{
						id: `${provider}-recent`,
						lat,
						lon,
						trip: 'fixture-trip',
						status: 'on_time',
						delay_min: 0,
						updated_utc: '2026-06-15T11:59:50Z',
					},
					{
						id: `${provider}-old`,
						lat: lat + (north - south) / 20,
						lon,
						trip: 'fixture-trip',
						status: 'late',
						delay_min: 2,
						reported_utc: '2026-06-15T11:54:00Z',
						updated_utc: '2026-06-15T11:54:00Z',
					},
				],
			};
			const t = reportsCopy[locale];
			test.beforeEach(async ({ page }) => {
				await page.clock.install({ time: Date.parse(GENERATED) + 30_000 });
				await serveFleet(page, () => file);
			});

			// Each viewport opens the map twice, including the copied link's camera round-trip.
			// Keep those independent journeys within their own test budgets.
			for (const width of [320, 390, 768, 1280])
				test(`preserves provider identity and raw source positions at ${width}px`, async ({
					page,
				}) => {
					await page.setViewportSize({ width, height: 900 });
					await page.goto(`${localizeHref(map, locale)}?provider=${provider}`);
					const panel = await openReports(page);
					await expect(panel.locator('[data-report-row]')).toHaveCount(2);
					await expect(panel.locator('[data-slot="map-in-view-count"]')).toHaveText('2');
					const rows = parseCsv((await downloadCsv(page)).bytes),
						header = rows[0];
					expect(rows.slice(1).map((row) => row[header.indexOf('vehicle_id')])).toEqual(
						file.vehicles.map((row) => row.id),
					);
					for (let i = 0; i < file.vehicles.length; i++) {
						const row = rows[i + 1],
							source = file.vehicles[i];
						expect(row[header.indexOf('provider')]).toBe(provider);
						expect(row[header.indexOf('locale')]).toBe(locale);
						expect(row[header.indexOf('publication_generation_id')]).toBe(
							`${provider}@vehicle_positions:${file.generated_utc}`,
						);
						expect(Number(row[header.indexOf('latitude')])).toBe(source.lat);
						expect(Number(row[header.indexOf('longitude')])).toBe(source.lon);
						expect(Number(row[header.indexOf('delay_min')])).toBe(source.delay_min);
					}
					await panel.getByRole('button', { name: t.copyLiveView }).click();
					const copied = new URL(await page.evaluate(() => navigator.clipboard.readText()));
					expect(copied.searchParams.get('provider')).toBe(provider);
					expect(copied.pathname).toBe(localizeHref(map, locale));
					const copiedTransform = await rendererTransform(page);
					await page.goto(copied.href);
					const reopened = await openReports(page);
					await expect(async () => {
						expectSameRendererGeometry(await rendererTransform(page), copiedTransform);
					}).toPass({ timeout: 5000 });
					await expect(reopened.locator('[data-report-row]')).toHaveCount(2);
					await expect(reopened.locator('[data-slot="map-in-view-count"]')).toHaveText('2');
				});
			test('exports no vehicle rows when only stops are shown', async ({ page }) => {
				await page.setViewportSize({ width: 1280, height: 900 });
				await page.goto(`${localizeHref(map, locale)}?provider=${provider}&entity=stop`);
				const panel = await openReports(page);
				await expect(panel.getByText(/No vehicles in view|Aucun véhicule en vue/)).toBeVisible();
				await expect(panel.locator('[data-report-row]')).toHaveCount(0);
				expect(parseCsv((await downloadCsv(page)).bytes)).toHaveLength(1);
			});
		});
	}

async function downloadCsv(page: Page) {
	const download = page.waitForEvent('download');
	await page.getByRole('button', { name: downloadAction }).click();
	const file = await download;
	const path = await file.path();
	if (!path) throw new Error('the CSV download has no readable bytes');
	return { bytes: readFileSync(path, 'utf8'), filename: file.suggestedFilename() };
}

for (const locale of PUBLISHED_LOCALES) {
	test(`${locale}: report list, counts, CSV and copied live link share one captured view`, async ({
		page,
	}) => {
		await page.clock.install({ time: Date.parse(GENERATED) + 30_000 });
		await serveFleet(page, () => fleet());
		await page.goto(`${localizeHref(map, locale)}?provider=stm&status=late`);

		const reports = reportsCopy[locale];
		const panel = await openReports(page);

		// Offscreen reports belong to another viewport and are not in this count.
		await expect(panel.locator('[data-slot="map-in-view-count"]')).toHaveText('3');
		await expect(panel.locator('[data-report-row]')).toHaveCount(3);

		const csv = await downloadCsv(page);
		expect(csv.filename).toBe(`map-reports-stm-${locale}.csv`);
		const rows = parseCsv(csv.bytes);
		expect(rows[0]).toEqual([...MAP_REPORT_CSV_COLUMNS]);
		expect(rows.slice(1)).toHaveLength(3);
		const record = Object.fromEntries(rows[0]!.map((key, index) => [key, rows[1]![index] ?? '']));
		expect(record).toMatchObject({
			provider: 'stm',
			report_scope: 'matching_vehicle_reports_in_current_map_view',
			active_filters: '["status:late"]',
			time_zone: 'America/Toronto',
			status: 'late',
			reported_utc: '2026-06-15T11:59:40Z',
			latitude: '45.55',
			longitude: '-73.9',
		});
		// The old report is flagged and stays in the export.
		expect(
			rows.slice(1).map((row) => row[MAP_REPORT_CSV_COLUMNS.indexOf('no_recent_position')]),
		).toContain('true');

		await expect(panel.getByText(reports.copyDisclaimer)).toBeVisible();
		await panel.getByRole('button', { name: reports.copyLiveView }).click();
		await expect(panel.getByText(reports.copied)).toBeVisible();
		const copied = await page.evaluate(() => navigator.clipboard.readText());
		const url = new URL(copied);
		expect(url.searchParams.get('provider')).toBe('stm');
		expect(url.searchParams.get('status')).toBe('late');
		expect(url.searchParams.getAll('mapview')).toHaveLength(1);
		expect(url.searchParams.has('focus')).toBe(false);
		expect(url.pathname).toContain(locale === 'en' ? '/map' : '/fr/map');

		const citeLabel = locale === 'fr' ? 'Citer' : 'Cite';
		await panel.getByRole('button', { name: citeLabel, exact: true }).click();
		const citation = page
			.getByRole('dialog')
			.filter({ has: page.getByRole('heading', { name: citeLabel, exact: true }) });
		// One citation block that carries the copied live link and its own Copy button.
		const block = citation.locator('[data-slot="cite-block"]');
		await expect(block).toHaveCount(1);
		await expect(block.locator('[data-slot="cite-text"]')).toContainText(copied);
		await expect(
			block.getByRole('button', { name: locale === 'fr' ? 'Copier' : 'Copy', exact: true }),
		).toBeVisible();
		await citation.getByRole('button', { name: locale === 'fr' ? 'Fermer' : 'Close' }).click();

		// Selecting a report opens detail only: no implicit filter and no camera change.
		const gotoBefore = page.url();
		const cameraBeforeSelection = await rendererCamera(page);
		const transformBeforeSelection = await rendererTransform(page);
		await panel.getByRole('link', { name: 'center-late', exact: true }).click();
		const detail = page
			.locator('[data-slot="map-detail-overlay"]')
			.filter({ hasText: 'center-late' });
		await expect(detail).toBeVisible();
		expect(page.url()).toBe(gotoBefore);
		const selectedCamera = await rendererCamera(page);
		for (let i = 0; i < cameraBeforeSelection.length; i++) {
			expect(selectedCamera[i]).toBeCloseTo(cameraBeforeSelection[i], 10);
		}
		expectSameRendererGeometry(await rendererTransform(page), transformBeforeSelection);

		await page.keyboard.press('Escape');
		await expect(panel.locator('[data-report-row]')).toHaveCount(3);
		await expect(panel.getByRole('link', { name: 'center-late', exact: true })).toBeFocused();
		await panel.getByRole('button', { name: reports.copyLiveView }).click();
		const afterSelection = await page.evaluate(() => navigator.clipboard.readText());
		// Constraint updates can differ by an IEEE-754 ulp. Keep the actual camera and
		// projected geometry fixed, rather than hiding a real move behind rounded URL text.
		const beforeHint = url.searchParams.get('mapview')!.split(',').map(Number);
		const afterHint = new URL(afterSelection).searchParams.get('mapview')!.split(',').map(Number);
		for (let i = 0; i < beforeHint.length; i++) expect(afterHint[i]).toBeCloseTo(beforeHint[i], 10);
		expectSameRendererGeometry(await rendererTransform(page), transformBeforeSelection);

		// Reloading the copied link restores the live filter scope against fresh data.
		await page.goto(copied);
		const reloaded = await openReports(page);
		await expect(reloaded.locator('[data-report-row]')).toHaveCount(3);
		await expect(reloaded.locator('[data-slot="map-in-view-count"]')).toHaveText('3');
		await expect(reloaded.getByText(reports.copyDisclaimer)).toBeVisible();
	});
}

test('live filters and a camera pan move the list, counts and CSV together', async ({
	page,
}, testInfo) => {
	await page.clock.install({ time: Date.parse(GENERATED) + 30_000 });
	await serveFleet(page, () => fleet());
	await page.goto(`${localizeHref(map, 'en')}?provider=stm&status=late`);
	const reports = reportsCopy.en;
	const panel = await openReports(page);
	const count = panel.locator('[data-slot="map-in-view-count"]');
	const rows = panel.locator('[data-report-row]');
	const countNumber = async () => Number(/(\d+)/u.exec(await count.innerText())?.[1]);
	await expect(count).toHaveText('3');
	const copyHint = async () => {
		await panel.getByRole('button', { name: reports.copyLiveView }).click();
		const href = await page.evaluate(() => navigator.clipboard.readText());
		return new URL(href).searchParams.get('mapview');
	};
	const beforeHint = await copyHint();
	const beforePan = await downloadCsv(page);

	// Removing the explicit status filter widens the same snapshot and its export.
	if (testInfo.project.name === 'desktop') {
		await openMapControls(page);
		await page.getByRole('button', { name: 'Map filters', exact: true }).click();
		await page.getByRole('checkbox', { name: 'Late', exact: true }).first().click();
		await expect(count).toHaveText('5');
		await expect(rows).toHaveCount(5);
		const filtered = await downloadCsv(page);
		expect(parseCsv(filtered.bytes).slice(1)).toHaveLength(5);
	}

	// An explicit named camera action changes the captured rows and the exported view together.
	const beforeCount = await countNumber();
	await closeMapInView(page);
	const zoomIn = page.getByRole('button', { name: 'Zoom in', exact: true });
	const startingZoom = (await rendererCamera(page))[2]!;
	for (let i = 0; i < 4; i++) {
		const currentZoom = (await rendererCamera(page))[2]!;
		await zoomIn.click();
		await expect.poll(async () => (await rendererCamera(page))[2]!).toBeGreaterThan(currentZoom);
		await page.clock.runFor(450);
	}
	expect((await rendererCamera(page))[2]).toBeGreaterThan(startingZoom);
	await openReports(page);
	await expect.poll(countNumber).toBeLessThan(beforeCount);
	const afterCount = await countNumber();
	expect(await copyHint()).not.toBe(beforeHint);
	expect(afterCount).toBeLessThan(beforeCount);
	await expect(rows).toHaveCount(afterCount);
	const panned = await downloadCsv(page);
	const pannedCells = parseCsv(panned.bytes);
	expect(pannedCells.slice(1)).toHaveLength(afterCount);
	const beforeCells = parseCsv(beforePan.bytes);
	const bboxOf = (cells: string[][]) =>
		cells[0]!.map((key, index) => [key, cells[1]?.[index] ?? ''] as const);
	const pannedRecord = Object.fromEntries(bboxOf(pannedCells));
	const beforeRecord = Object.fromEntries(bboxOf(beforeCells));
	expect(pannedRecord.view_bbox_west).not.toBe(beforeRecord.view_bbox_west);
	expect(pannedRecord.view_zoom).not.toBe(beforeRecord.view_zoom);
});

test('a newer source generation moves the list, count and CSV together', async ({ page }) => {
	await page.clock.install({ time: Date.parse(GENERATED) + 30_000 });
	let file = fleet();
	await serveFleet(page, () => file);
	await page.goto(`${localizeHref(map, 'en')}?provider=stm&status=late`);
	const panel = await openReports(page);
	const count = panel.locator('[data-slot="map-in-view-count"]');
	await expect(count).toHaveText('3');

	file = fleet({ generated_utc: '2026-06-15T12:00:20Z', extraLate: true });
	await page.clock.fastForward('00:35');
	await expect(count).toHaveText('4');
	await expect(panel.locator('[data-report-row]')).toHaveCount(4);
	await expect(
		page.locator('[data-slot="map-frame"] [data-slot="freshness-stamp"] time'),
	).toHaveAttribute('datetime', '2026-06-15T12:00:20Z');
	const updated = await downloadCsv(page);
	expect(parseCsv(updated.bytes).slice(1)).toHaveLength(4);
});

test('selecting an in-view link and pressing Escape restores its focus @theme', async ({
	page,
}) => {
	await page.clock.install({ time: Date.parse(GENERATED) + 30_000 });
	await serveFleet(page, () => fleet());
	await page.goto('/map?provider=stm&status=late');
	const panel = await openReports(page);
	const row = panel.getByRole('link', { name: 'center-late', exact: true });
	await row.click();
	await expect(page.locator('[data-slot="map-detail-overlay"]')).toContainText('center-late');
	await page.keyboard.press('Escape');
	await expect(row).toBeFocused();
	await expectFocusedTargetUncovered(page);
});
test('loading, unavailable and retained states never show a reassuring zero @motion', async ({
	page,
}) => {
	await page.clock.install({ time: Date.parse(GENERATED) + 30_000 });
	let fail = false;
	let file: FleetFile = fleet();
	await page.route(captureUrl, (route) =>
		fail
			? route.fulfill({ status: 500, body: 'down' })
			: route.fulfill({ json: fleetCapture(file, 'stm') }),
	);
	await page.goto(`${localizeHref(map, 'en')}?provider=stm`);
	const panel = await openReports(page);
	await expect(panel.locator('[data-slot="map-in-view-count"]')).toBeVisible();

	fail = true;
	await page.clock.fastForward('00:35');
	await expect(page.getByText(/at the last report/)).toBeVisible();
	await expect(panel.locator('[data-report-row]')).not.toHaveCount(0);
	await expect(panel.locator('[data-slot="map-in-view-count"]')).toHaveText('5');

	// A successful empty snapshot is a true zero, with its header-only export.
	fail = false;
	file = { generated_utc: '2026-06-15T12:00:20Z', vehicles: [] };
	await page.clock.fastForward('00:35');
	await expect(panel.getByText('No vehicles in view.')).toBeVisible();
	await expect(panel.locator('[data-slot="map-in-view-count"]')).toHaveText('0');
	const empty = await downloadCsv(page);
	expect(parseCsv(empty.bytes)).toHaveLength(1);
});

test('unknown live data is unavailable, not zero', async ({ page }) => {
	await page.route(captureUrl, (route) => route.fulfill({ status: 404, body: '' }));
	await page.goto(`${localizeHref(map, 'en')}?provider=stm`);
	const panel = await openReports(page);
	await expect(panel.getByText(reportsCopy.en.unavailableSource)).toBeVisible();
	await expect(panel.locator('[data-slot="map-in-view-count"]')).toHaveCount(0);
});

test('unknown alert-filter evidence does not turn valid vehicle reports into a reassuring zero', async ({
	page,
}) => {
	await page.clock.install({ time: Date.parse(GENERATED) + 30_000 });
	await page.route(captureUrl, (route) => {
		const snapshot = fleetCapture(fleet(), 'stm');
		snapshot.alerts = null;
		Object.assign(snapshot.feeds.i3_alerts!, { captured_at: null, read_failed: true });
		return route.fulfill({ json: snapshot });
	});
	await page.goto(`${localizeHref(map, 'en')}?provider=stm&alert=has_alert`);
	const panel = await openReports(page);
	await expect(panel.getByText('No vehicles in view.')).toHaveCount(0);
	await expect(panel.getByRole('button', { name: downloadAction })).toHaveCount(0);
	await expect(panel.getByRole('status')).toContainText(/alert/i);
});

test('retained alert matches keep their own source identity and recover to a known empty filter', async ({
	page,
}) => {
	await page.clock.install({ time: Date.parse(GENERATED) + 30_000 });
	let failing = false;
	let recovered = false;
	let alertTime = '2026-06-15T12:00:10Z';
	await page.route(captureUrl, (route) => {
		const snapshot = fleetCapture(fleet(), 'stm');
		Object.assign(snapshot.feeds.i3_alerts!, {
			captured_at: alertTime,
			source_at: alertTime,
			read_failed: failing,
		});
		snapshot.alerts = recovered
			? []
			: [
					{
						id: 'route24',
						header: { en: 'Fixture alert', fr: 'Alerte témoin' },
						description: {},
						url: {},
						cause: null,
						effect: null,
						severity: null,
						routes: ['24'],
						stops: [],
						periods: [],
					},
				];
		return route.fulfill({ json: snapshot });
	});
	await page.goto(`${localizeHref(map, 'en')}?provider=stm&alert=has_alert`);
	const panel = await openReports(page);
	await expect(panel.locator('[data-report-row]')).toHaveCount(2);

	const current = parseCsv((await downloadCsv(page)).bytes);
	let header = current[0];
	for (const row of current.slice(1)) {
		expect(row[header.indexOf('source_generated_utc')]).toBe(GENERATED);
		expect(row[header.indexOf('alert_filter_generated_utc')]).toBe(alertTime);
		expect(row[header.indexOf('alert_filter_generation_id')]).toBe(`stm@alerts:${alertTime}`);
		expect(row[header.indexOf('alert_filter_methodology_version')]).toBe('capture-live-v2');
		expect(row[header.indexOf('alert_filter_data_state')]).toBe('current');
	}
	failing = true;
	await page.clock.fastForward('00:35');

	await expect(panel.locator('[data-report-row]')).toHaveCount(2);
	const retained = parseCsv((await downloadCsv(page)).bytes);
	header = retained[0];
	for (const row of retained.slice(1)) {
		expect(row[header.indexOf('alert_filter_generated_utc')]).toBe(alertTime);
		expect(row[header.indexOf('alert_filter_data_state')]).toBe('last_available');
	}
	failing = false;
	recovered = true;
	alertTime = '2026-06-15T12:01:20Z';
	await page.clock.fastForward('00:35');
	await expect(panel.getByText('No vehicles in view.')).toBeVisible();

	expect(parseCsv((await downloadCsv(page)).bytes)).toHaveLength(1);
});

test('report list holds 320px French, a short laptop and 200% text with reachable focus @theme', async ({
	page,
}) => {
	await page.clock.install({ time: Date.parse(GENERATED) + 30_000 });
	await serveFleet(page, () => fleet());
	await page.goto(`${localizeHref(map, 'fr')}?provider=stm&status=late`);

	for (const [width, height] of [
		[320, 720],
		[390, 844],
		[768, 1024],
		[1280, 720],
	] as const) {
		await page.setViewportSize({ width, height });

		await openReports(page);
		await expectNoHorizontalOverflow(page);
		await expectTapTargets(page, { exclude: ['.maplibregl-ctrl'] });
		await expectAccessible(page);
	}

	// 200% text on a short laptop keeps the switch, list and evidence actions reachable.
	await page.setViewportSize({ width: 1280, height: 720 });
	await page.evaluate(() => {
		document.documentElement.style.fontSize = '32px';
	});
	await openReports(page);
	await expectNoHorizontalOverflow(page);
	await expectTapTargets(page, { exclude: ['.maplibregl-ctrl'] });
	await expectAccessible(page);
	await page.getByRole('button', { name: downloadAction }).focus();
	await expectFocusedTargetUncovered(page);
	await page.evaluate(() => {
		document.documentElement.style.fontSize = '';
	});

	// Escape returns from the list to the map with focus on the reachable switch.
	await page.setViewportSize({ width: 390, height: 844 });
	await openReports(page);
	await page.locator('[data-map-in-view-title]').focus();
	await page.keyboard.press('Escape');
	await expect(page.locator('[data-slot="map-in-view"]')).toHaveCount(0);
	const mapTab = page.locator('.map-in-view-button');
	await expect(mapTab).toBeFocused();
});
