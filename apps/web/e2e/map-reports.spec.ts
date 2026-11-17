import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import {
	expectAccessible,
	expectNoHorizontalOverflow,
	expectTapTargets,
} from '@yesid/config/playwright';
import { copy as reportsCopy } from '../src/lib/features/map/mapReports.copy';
import { MAP_SELECTION_DETAIL_COPY } from '../src/lib/features/map/mapSelectionDetail.copy';
import { MAP_REPORT_CSV_COLUMNS } from '../src/lib/features/map/mapReportsCsv';
import { PUBLISHED_LOCALES } from '../src/lib/i18n/config';
import { localizeHref } from '../src/lib/i18n/routing';
import { SURFACE_NAV } from '../src/lib/content/nav';

const map = SURFACE_NAV.find((item) => item.key === 'map')!.href;
const GENERATED = '2026-06-15T12:00:00Z';

// A small, deliberate fleet: two late vehicles in view, one older report, one on time,
// one early without a reported time, one offscreen, and one with no usable location.
const fleet = (overrides: { generated_utc?: string; extraLate?: boolean } = {}) => ({
	generated_utc: overrides.generated_utc ?? GENERATED,
	publish_generation_id: 'stm@reports-e2e',
	methodology_version: 'e2e',
	vehicles: [
		{
			id: 'west-late',
			lat: 45.55,
			lon: -73.9,
			status: 'late',
			delay_min: 4,
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
			delay_min: 0,
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
			delay_min: -2,
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
			delay_min: 1,
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
						delay_min: 6,
						route: '55',
						trip: 't8',
						updated_utc: '2026-06-15T11:59:55Z',
					},
				]
			: []),
	],
});

test.use({ bypassCSP: true, permissions: ['clipboard-read', 'clipboard-write'] });

async function serveFleet(page: Page, current: () => Record<string, unknown>) {
	await page.route('**/live/vehicles.json', (route) => route.fulfill({ json: current() }));
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

async function openReports(page: Page, locale: 'en' | 'fr') {
	const t = reportsCopy[locale];
	await page.getByRole('radio', { name: t.reportsTab, exact: true }).first().click();
	const panel = page.locator('[data-slot="map-reports"]').first();
	await expect(panel).toBeVisible();
	return panel;
}

async function downloadCsv(page: Page, t: (typeof reportsCopy)['en'] | (typeof reportsCopy)['fr']) {
	const download = page.waitForEvent('download');
	await page.getByRole('link', { name: t.downloadCsv }).click();
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
		const panel = await openReports(page, locale);
		await expect(panel.getByText('STM')).toBeVisible();
		await expect(panel.getByText(reports.reportsScope)).toBeVisible();
		await expect(panel.getByText(reports.sourceTime)).toBeVisible();
		await expect(panel.getByText('UTC')).toBeVisible();
		// Offscreen reports belong to another viewport and are not in this count.
		await expect(panel.locator('[data-slot="map-reports-count"]')).toHaveText(
			reports.reportsCount('3', '1', 3, 1),
		);
		await expect(panel.locator('[data-report-row]')).toHaveCount(3);

		const csv = await downloadCsv(page, reports);
		expect(csv.filename).toBe(`map-reports-stm-${locale}.csv`);
		const rows = parseCsv(csv.bytes);
		expect(rows[0]).toEqual([...MAP_REPORT_CSV_COLUMNS]);
		expect(rows.slice(1)).toHaveLength(3);
		const record = Object.fromEntries(rows[0]!.map((key, index) => [key, rows[1]![index] ?? '']));
		expect(record).toMatchObject({
			provider: 'stm',
			report_scope: 'matching_vehicle_reports_in_current_map_view',
			active_filters: 'status:late',
			time_zone: 'UTC',
			status: 'late',
			reported_utc: '2026-06-15T11:59:40Z',
			latitude: '45.55',
			longitude: '-73.9',
		});
		// A real zero stays numeric; the old report is flagged, never removed.
		expect(rows.slice(1).map((row) => row[MAP_REPORT_CSV_COLUMNS.indexOf('delay_min')])).toContain(
			'0',
		);
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

		// Selecting a report opens detail only: no implicit filter and no camera change.
		const gotoBefore = page.url();
		await panel.getByRole('button', { name: reports.selectVehicle('center-late') }).click();
		const detail = page
			.getByRole('complementary', { name: /center-late/u })
			.or(page.getByRole('dialog', { name: /center-late/u }));
		await expect(detail).toBeVisible();
		expect(page.url()).toBe(gotoBefore);

		await page.keyboard.press('Escape');
		await expect(panel.locator('[data-report-row]')).toHaveCount(3);
		await expect(
			panel.getByRole('button', { name: reports.selectVehicle('center-late') }),
		).toBeFocused();
		await panel.getByRole('button', { name: reports.copyLiveView }).click();
		const afterSelection = await page.evaluate(() => navigator.clipboard.readText());
		// The camera did not move for the selection: the copied hint is byte-identical.
		expect(new URL(afterSelection).searchParams.get('mapview')).toBe(
			url.searchParams.get('mapview'),
		);

		// Reloading the copied link restores the live filter scope against fresh data.
		await page.goto(copied);
		const reloaded = await openReports(page, locale);
		await expect(reloaded.locator('[data-report-row]')).toHaveCount(3);
		await expect(reloaded.locator('[data-slot="map-reports-count"]')).toHaveText(
			reports.reportsCount('3', '1', 3, 1),
		);
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
	const panel = await openReports(page, 'en');
	const count = panel.locator('[data-slot="map-reports-count"]');
	const rows = panel.locator('[data-report-row]');
	const countNumber = async () => Number(/(\d+)/u.exec(await count.innerText())?.[1]);
	await expect(count).toHaveText(reports.reportsCount('3', '1', 3, 1));
	const copyHint = async () => {
		await panel.getByRole('button', { name: reports.copyLiveView }).click();
		const href = await page.evaluate(() => navigator.clipboard.readText());
		return new URL(href).searchParams.get('mapview');
	};
	const beforeHint = await copyHint();
	const beforePan = await downloadCsv(page, reports);

	// Removing the explicit status filter widens the same snapshot and its export.
	if (testInfo.project.name === 'desktop') {
		await page.getByRole('checkbox', { name: 'Late', exact: true }).first().click();
		await expect(count).toHaveText(reports.reportsCount('5', '1', 5, 1));
		await expect(rows).toHaveCount(5);
		const filtered = await downloadCsv(page, reports);
		expect(parseCsv(filtered.bytes).slice(1)).toHaveLength(5);
	}

	// An explicit named camera action changes the captured rows and the exported view together.
	const beforeCount = await countNumber();
	await panel.getByRole('button', { name: reports.selectVehicle('west-late') }).click();
	const westDetail = page
		.getByRole('complementary', { name: /west-late/u })
		.or(page.getByRole('dialog', { name: /west-late/u }));
	await expect(westDetail).toBeVisible();
	await page.getByRole('button', { name: MAP_SELECTION_DETAIL_COPY.en.previousVehicle }).click();
	const focusedDetail = page
		.getByRole('complementary', { name: /old-late/u })
		.or(page.getByRole('dialog', { name: /old-late/u }));
	await expect(focusedDetail).toBeVisible();
	await page.keyboard.press('Escape');
	const afterCount = await countNumber();
	expect(await copyHint()).not.toBe(beforeHint);
	expect(afterCount).toBeLessThan(beforeCount);
	await expect(rows).toHaveCount(1);
	await expect(count).toHaveText(reports.reportsCount('1', '1', 1, 1));
	const panned = await downloadCsv(page, reports);
	const pannedCells = parseCsv(panned.bytes);
	expect(pannedCells.slice(1)).toHaveLength(1);
	const beforeCells = parseCsv(beforePan.bytes);
	const bboxOf = (cells: string[][]) =>
		cells[0]!.map((key, index) => [key, cells[1]?.[index] ?? ''] as const);
	const pannedRecord = Object.fromEntries(bboxOf(pannedCells));
	const beforeRecord = Object.fromEntries(bboxOf(beforeCells));
	expect(pannedRecord.view_bbox_west).not.toBe(beforeRecord.view_bbox_west);
	expect(pannedRecord.view_center_lon).not.toBe(beforeRecord.view_center_lon);
});

test('a newer source generation moves the list, count and CSV together', async ({ page }) => {
	await page.clock.install({ time: Date.parse(GENERATED) + 30_000 });
	let file = fleet();
	await serveFleet(page, () => file);
	await page.goto(`${localizeHref(map, 'en')}?provider=stm&status=late`);
	const reports = reportsCopy.en;
	const panel = await openReports(page, 'en');
	const count = panel.locator('[data-slot="map-reports-count"]');
	await expect(count).toHaveText(reports.reportsCount('3', '1', 3, 1));

	file = fleet({ generated_utc: '2026-06-15T12:00:20Z', extraLate: true });
	await page.clock.fastForward('00:35');
	await expect(count).toHaveText(reports.reportsCount('4', '1', 4, 1));
	await expect(panel.locator('[data-report-row]')).toHaveCount(4);
	await expect(panel.locator('time').first()).toHaveAttribute('datetime', '2026-06-15T12:00:20Z');
	const updated = await downloadCsv(page, reports);
	expect(parseCsv(updated.bytes).slice(1)).toHaveLength(4);
});

test('the named sibling focus moves the camera and Escape returns to the list @theme', async ({
	page,
}) => {
	await page.clock.install({ time: Date.parse(GENERATED) + 30_000 });
	await serveFleet(page, () => fleet());
	await page.goto(`${localizeHref(map, 'en')}?provider=stm&status=late`);
	const reports = reportsCopy.en;
	const panel = await openReports(page, 'en');
	await panel.getByRole('button', { name: reports.selectVehicle('center-late') }).click();
	await expect(page.getByRole('complementary', { name: /center-late/u })).toBeVisible();
	const beforeFocus = page.url();
	await page.getByRole('button', { name: MAP_SELECTION_DETAIL_COPY.en.nextVehicle }).click();
	await expect(page.getByRole('complementary', { name: /early-fallback/u })).toBeVisible();
	expect(page.url()).toBe(beforeFocus);
	await page.keyboard.press('Escape');
	await expect(page.getByRole('complementary', { name: /early-fallback/u })).toHaveCount(0);
	await expect(page.locator('.map-reports-title').first()).toBeFocused();
});

test('loading, unavailable and retained states never show a reassuring zero @motion', async ({
	page,
}) => {
	await page.clock.install({ time: Date.parse(GENERATED) + 30_000 });
	let fail = false;
	let file = fleet();
	await page.route('**/live/vehicles.json', (route) =>
		fail ? route.fulfill({ status: 500, body: 'down' }) : route.fulfill({ json: file }),
	);
	const reports = reportsCopy.en;
	await page.goto(`${localizeHref(map, 'en')}?provider=stm`);
	const panel = await openReports(page, 'en');
	await expect(panel.locator('[data-slot="map-reports-count"]')).toBeVisible();

	fail = true;
	await page.clock.fastForward('00:35');
	await expect(panel.getByText(reports.retainedWarning)).toBeVisible();
	await expect(panel.locator('[data-report-row]')).not.toHaveCount(0);
	await expect(panel.locator('[data-slot="map-reports-count"]')).toHaveText(
		reports.reportsCount('5', '1', 5, 1),
	);

	// A successful empty snapshot is a true zero, with its header-only export.
	fail = false;
	file = { generated_utc: '2026-06-15T12:00:20Z', vehicles: [] };
	await page.clock.fastForward('00:35');
	await expect(panel.getByText(reports.reportsEmpty)).toBeVisible();
	await expect(panel.locator('[data-slot="map-reports-count"]')).toHaveCount(0);
	const empty = await downloadCsv(page, reports);
	expect(parseCsv(empty.bytes)).toHaveLength(1);
});

test('unknown live data is unavailable, not zero', async ({ page }) => {
	await page.route('**/live/vehicles.json', (route) => route.fulfill({ status: 404, body: '' }));
	await page.goto(`${localizeHref(map, 'en')}?provider=stm`);
	const panel = await openReports(page, 'en');
	await expect(panel.getByText(reportsCopy.en.unavailableSource)).toBeVisible();
	await expect(panel.locator('[data-slot="map-reports-count"]')).toHaveCount(0);
});

test('report list holds 320px French, a short laptop and 200% text with reachable focus @theme', async ({
	page,
}) => {
	await page.clock.install({ time: Date.parse(GENERATED) + 30_000 });
	await serveFleet(page, () => fleet());
	await page.goto(`${localizeHref(map, 'fr')}?provider=stm&status=late`);
	const reports = reportsCopy.fr;

	for (const [width, height] of [
		[320, 720],
		[390, 844],
		[768, 1024],
		[1280, 720],
	] as const) {
		await page.setViewportSize({ width, height });
		if (width >= 1024) {
			await page.getByRole('radio', { name: reports.reportsTab, exact: true }).first().click();
		} else if (!(await page.locator('[data-slot="map-reports"]').first().isVisible())) {
			await page.getByRole('radio', { name: reports.reportsTab, exact: true }).first().click();
		}
		const panel = page.locator('[data-slot="map-reports"]').first();
		await expect(panel).toBeVisible();
		await expect(
			page.getByRole('radio', { name: reports.mapTab, exact: true }).first(),
		).toBeVisible();
		await expectNoHorizontalOverflow(page);
		await expectTapTargets(page, { exclude: ['.maplibregl-ctrl'] });
		await expectAccessible(page);
	}

	// 200% text on a short laptop keeps the switch, list and evidence actions reachable.
	await page.setViewportSize({ width: 1280, height: 720 });
	await page.evaluate(() => {
		document.documentElement.style.fontSize = '32px';
	});
	await expect(page.locator('[data-slot="map-reports"]').first()).toBeVisible();
	await expectNoHorizontalOverflow(page);
	await expectTapTargets(page, { exclude: ['.maplibregl-ctrl'] });
	await expectAccessible(page);
	await page.evaluate(() => {
		document.documentElement.style.fontSize = '';
	});

	// Escape returns from the list to the map with focus on the reachable switch.
	await page.setViewportSize({ width: 390, height: 844 });
	await page.locator('[data-slot="map-reports"]').first().focus();
	await page.keyboard.press('Escape');
	await expect(page.locator('[data-slot="map-reports"]')).toHaveCount(0);
	const mapTab = page.getByRole('radio', { name: reports.mapTab, exact: true }).first();
	await expect(mapTab).toBeFocused();
});
