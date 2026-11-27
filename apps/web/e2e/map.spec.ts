import { mapControlsPill, openMapControls } from './map-frame-controls';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { revealRefresh } from './header-refresh';
import { captureFixture, captureUrl } from './capture-fixture';

import { refreshCopy } from '../src/lib/components/shell/refresh.copy';
import { SURFACE_NAV } from '../src/lib/content/nav';
import { copy as mapCopy } from '../src/lib/features/map/map.copy';
import { PUBLISHED_LOCALES } from '../src/lib/i18n/config';
import { localizeHref } from '../src/lib/i18n/routing';

const fixture = (name: string) =>
	JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'));
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stop = fixture('stops-index.json').stops[0];
const map = SURFACE_NAV.find((item) => item.key === 'map')!.href;
// The banner reads the oldest live family; the map always loads alerts.
const generated = Date.parse(fixture('alerts.json').generated_utc);
const address = {
	lat: stop.lat,
	lon: stop.lon,
	label: 'Fixture address',
	source: 'geo_ca',
	precision: 'address',
};

// Every element a CSS animation or transition starts on, recorded from page load.
const recordMotion = () => {
	const started: Element[] = [];
	Object.assign(window, { started });
	for (const type of ['animationstart', 'transitionrun'])
		addEventListener(type, (event) => started.push(event.target as Element), true);
};

test.use({ bypassCSP: true });

test.beforeEach(async ({ page }) => {
	await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
	await page.route('**/api/geocode**', (route) => route.fulfill({ json: { results: [address] } }));
});

// Server markup shows the toggle before hydration wires it; retry until the panel opens.
async function openNearMe(page: Page, name: string) {
	await page.getByRole('button', { name, exact: true }).click();
	await expect(page.locator('[data-slot="map-address-lookup"]')).toBeVisible();
}

test('manual refresh stays busy until live data is received and rendered', async ({ page }) => {
	await page.clock.install({ time: generated + 15_000 });
	let hold = false;
	let release!: () => void;
	let markHeld!: () => void;
	const responseGate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const held = new Promise<void>((resolve) => {
		markHeld = resolve;
	});
	const newer = generated + 5000;
	await page.route(captureUrl, async (route) => {
		if (hold) {
			markHeld();
			await responseGate;
		}
		await route.fulfill({
			json: captureFixture(hold ? newer : generated),
		});
	});
	await page.goto('/map?provider=stm');

	const timestamp = page.locator('[data-slot="map-frame"] [data-slot="freshness-stamp"] time');
	await expect(timestamp).toHaveAttribute('datetime', new Date(generated).toISOString());
	hold = true;
	const invalidated = page.waitForResponse((response) => response.url().includes('__data.json'));
	try {
		await (await revealRefresh(page)).click();
		await held;
		await (await invalidated).finished();
		await page.clock.runFor(250);
		await expect(page.getByRole('button', { name: /Refreshing…$/u })).toBeDisabled();
		release();
		await expect(page.getByRole('button', { name: /Refresh data$/u })).toBeEnabled();
		await expect(timestamp).toHaveAttribute('datetime', new Date(newer).toISOString());
	} finally {
		release();
	}
});

test('a manual refresh shows its result under the button, moves nothing, then leaves', async ({
	page,
}) => {
	await page.clock.install({ time: generated + 15_000 });
	await page.route(captureUrl, (route) => route.fulfill({ json: captureFixture(generated) }));
	await page.goto('/map?provider=stm', { waitUntil: 'networkidle' });

	const stamp = page.locator(`[data-slot="map-frame"] [data-slot="freshness-stamp"]`);
	const banner = page.getByRole('banner');
	const button = await revealRefresh(page);
	const boxes = [await banner.boundingBox(), await stamp.boundingBox()];
	await button.click();
	const result = page.locator('[data-slot="refresh-result"]');
	await expect(result).toHaveText(
		new RegExp(`^${literal(refreshCopy.en.updated('\0')).replace('\0', '.+')}$`),
	);
	await expect(result).toHaveAttribute('role', 'status');
	const box = (await result.boundingBox())!;
	expect(box.x).toBeGreaterThanOrEqual(16);
	expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width - 16);
	expect(box.y).toBeGreaterThanOrEqual(
		(await button.boundingBox())!.y + (await button.boundingBox())!.height,
	);
	expect([await banner.boundingBox(), await stamp.boundingBox()]).toEqual(boxes);
	await page.clock.runFor(8_000);
	await expect(result).toBeEmpty();
});

for (const reducedMotion of ['reduce', 'no-preference'] as const) {
	test(`report age advances each second while idle (${reducedMotion})`, async ({ page }) => {
		await page.emulateMedia({ reducedMotion });
		await page.clock.install({ time: generated + 15_000 });
		await page.route(captureUrl, (route) => route.fulfill({ json: captureFixture(generated) }));
		await page.goto('/map', { waitUntil: 'networkidle' });

		const stamp = page.locator(`[data-slot="map-frame"] [data-slot="freshness-stamp"]`);
		await expect(stamp).toHaveAttribute('data-age-seconds', /^\d+$/);
		const age = Number(await stamp.getAttribute('data-age-seconds'));
		await page.clock.runFor(2100);
		await expect
			.poll(async () => Number(await stamp.getAttribute('data-age-seconds')))
			.toBeGreaterThanOrEqual(age + 2);
	});

	test(`manual refresh does not make an unchanged report younger (${reducedMotion})`, async ({
		page,
	}) => {
		await page.emulateMedia({ reducedMotion });
		const cachedDate = new Date(generated + 15_000).toUTCString();
		const clockHeaders = {
			date: cachedDate,
			age: '0',
			'access-control-allow-origin': '*',
			'access-control-expose-headers': 'Date, Age',
		};
		await page.clock.install({ time: generated + 15_000 });
		await page.route(captureUrl, (route) =>
			route.fulfill({ json: captureFixture(generated), headers: clockHeaders }),
		);
		await page.goto('/map?provider=stm');

		const stamp = page.locator(`[data-slot="map-frame"] [data-slot="freshness-stamp"]`);
		await expect(stamp).toHaveAttribute('data-age-seconds', /^\d+$/);
		const originalAge = Number(await stamp.getAttribute('data-age-seconds'));
		const timestamp = await stamp.locator('time').getAttribute('datetime');
		for (let click = 1; click <= 3; click += 1) {
			await page.clock.runFor(1100);
			const refreshed = page.waitForResponse((response) => captureUrl.test(response.url()));
			await (await revealRefresh(page)).click();
			await refreshed;
			await expect(page.getByRole('button', { name: /Refresh data$/u })).toBeEnabled();
			await expect
				.poll(async () => Number(await stamp.getAttribute('data-age-seconds')))
				.toBeGreaterThanOrEqual(originalAge + click);
			await expect(stamp.locator('time')).toHaveAttribute('datetime', timestamp!);
		}
	});
}

for (const locale of PUBLISHED_LOCALES) {
	const t = mapCopy[locale];
	// The stall message at any age.
	const stall = new RegExp(literal(t.feedNotResponding('\0')).replace('\0', '.+'));

	test(`${locale}: an address lists the stop beside it, which opens its details without motion`, async ({
		page,
	}) => {
		await page.addInitScript(recordMotion);
		await page.goto(localizeHref(map, locale));
		await openMapControls(page);
		await openNearMe(page, locale === 'fr' ? 'Près d’une adresse' : 'Near an address');
		const input = page.getByRole('combobox', { name: t.nearMeAddressLabel });
		expect((await input.boundingBox())!.width).toBeGreaterThanOrEqual(280);
		await input.fill(address.label);
		const suggestion = page
			.getByRole('listbox', { name: t.nearMeSuggestions })
			.getByRole('option', { name: new RegExp(literal(address.label)) });
		await expect(suggestion).toBeVisible();
		await page.keyboard.press('ArrowDown');
		await expect(suggestion).toHaveAttribute('aria-selected', 'true');
		await page.keyboard.press('Enter');
		const nearby = page.locator('[data-slot="map-nearby-stops"]');
		await expect(nearby.getByRole('heading')).toContainText(address.label);
		await expect(nearby.locator('[data-map-row-code]').first()).not.toBeEmpty();
		await nearby.getByRole('link', { name: new RegExp(`^${literal(stop.name)}`) }).click();

		// A side panel on desktop, a sheet below.
		const detail = page.locator('[data-slot="map-detail-overlay"]');
		await expect(detail).toBeVisible();
		// Reduced motion (the suite's default): nothing on the surface animated in. The click
		// ripple stays on by design (@yesid/motion globalRipple) and is not part of the surface.
		expect(
			await detail.evaluate((surface) =>
				(window as unknown as { started: Element[] }).started
					.filter((target) => target.contains(surface) || surface.contains(target))
					.map((target) => target.getAttribute('class')),
			),
		).toEqual([]);
	});

	test(`${locale}: a stalled feed says so while the map controls stay apart and usable`, async ({
		page,
	}) => {
		await page.clock.install({ time: generated });
		let capturedAt = generated;
		await page.route(captureUrl, (route) => {
			const capture = captureFixture(capturedAt);
			capture.feeds.vehicle_positions!.expected_every_seconds = 30;
			return route.fulfill({ json: capture });
		});
		const snapshot = page.waitForResponse((response) => captureUrl.test(response.url()));
		await page.goto(localizeHref(map, locale));
		await snapshot;
		const banner = page.getByRole('status').filter({ hasText: stall });
		await expect(page.getByTestId('map-progressive')).toHaveAttribute(
			'data-map-progressive-state',
			'ready',
		);
		const nearMe = (await mapControlsPill(page).isVisible())
			? mapControlsPill(page)
			: page.getByRole('button', { name: t.nearMe, exact: true });
		await expect(nearMe).toBeVisible();
		await expect(page.getByRole('status').filter({ hasText: t.liveNoVehicles })).toBeVisible();
		await expect(banner).toHaveCount(0);
		const stamp = page.locator('[data-slot="map-frame"] [data-slot="freshness-stamp"]');
		await page.clock.fastForward(70_000);
		await expect
			.poll(async () => Number(await stamp.getAttribute('data-age-seconds')))
			.toBeGreaterThanOrEqual(70);
		await expect(stamp).toHaveAttribute('data-stale', 'false');
		await expect(banner).toHaveCount(0);

		// The retained report is beyond the feed's freshness window and its delivery allowance.
		await page.clock.fastForward('05:00');
		await expect(banner).toBeVisible();

		const attribution = page.getByLabel(t.attributionToggle, { exact: true }).locator('..');
		const chip = page.locator('[data-slot="map-live-chip"]');
		const compact = await chip.isVisible();
		if (compact) {
			await expect(chip).toContainText(locale === 'fr' ? 'Direct interrompu' : 'Live feed stalled');
		}
		const controls = [
			compact ? chip : banner,
			nearMe,
			page.getByRole('group', {
				name: locale === 'fr' ? 'Navigation de la carte' : 'Map navigation',
			}),
		];
		if (await attribution.isVisible()) controls.push(attribution);
		else await expect(attribution).toHaveClass(/maplibregl-attrib-empty/);
		for (const control of controls) await expect(control).toBeVisible();
		const boxes = await Promise.all(
			controls.map(async (control) => (await control.boundingBox())!),
		);
		const viewport = page.viewportSize()!;
		for (const [i, a] of boxes.entries()) {
			expect(a.x >= 0 && a.y >= 0, `control ${i} starts inside the viewport`).toBe(true);
			expect(a.x + a.width <= viewport.width && a.y + a.height <= viewport.height).toBe(true);
			for (const b of boxes.slice(i + 1)) {
				const overlap =
					a.x < b.x + b.width &&
					b.x < a.x + a.width &&
					a.y < b.y + b.height &&
					b.y < a.y + a.height;
				expect(overlap, `control ${i} overlaps a later one`).toBe(false);
			}
		}
		await openMapControls(page);
		await openNearMe(page, locale === 'fr' ? 'Près d’une adresse' : 'Near an address');

		capturedAt = await page.evaluate(() => Date.now());
		const recovered = page.waitForResponse((response) => captureUrl.test(response.url()));
		await page.clock.fastForward(20_000);
		await recovered;
		await expect(stamp.locator('time')).toHaveAttribute(
			'datetime',
			new Date(capturedAt).toISOString(),
		);
		await expect(stamp).toHaveAttribute('data-stale', 'false');
		await expect(banner).toHaveCount(0);
	});
}
