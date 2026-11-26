import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { openMapControls } from './map-frame-controls';
import { SURFACE_NAV } from '../src/lib/content/nav';
import { copy as mapCopy } from '../src/lib/features/map/map.copy';
import { PUBLISHED_LOCALES } from '../src/lib/i18n/config';
import { localizeHref } from '../src/lib/i18n/routing';
import { captureFixture, captureUrl, captureVehicle } from './capture-fixture';

const fixture = (name: string) =>
	JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'));
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const map = SURFACE_NAV.find((item) => item.key === 'map')!.href;
// The fixture data server is a separate origin; its published snapshot is not a page resource.
test.use({ bypassCSP: true });
const GENERATED = '2026-06-15T12:00:00Z';
const FIRST_ETA = '2026-06-15T12:05:00Z';
const SECOND_ETA = '2026-06-15T12:10:00Z';
const THIRD_ETA = '2026-06-15T12:15:00Z';
const FOURTH_ETA = '2026-06-15T12:20:00Z';
const publishedStop = fixture('stops-index.json').stops[0];
const providers = fixture('providers.json').providers as {
	id: string;
	fit_bounds: [number, number, number, number];
}[];

/**
 * Each provider keeps the published fixture stop, moved inside its own published fit bounds so
 * the real near-me search accepts the origin. The instant and the reader clock are unchanged.
 */
function networkFor(provider: 'stm' | 'octranspo') {
	const bounds = providers.find((row) => row.id === provider)?.fit_bounds;
	if (!bounds) throw new Error(`missing published bounds for ${provider}`);
	const [west, south, east, north] = bounds;
	const atBoundsCentre = provider !== 'stm';
	const lat = atBoundsCentre ? (south + north) / 2 : publishedStop.lat;
	const lon = atBoundsCentre ? (west + east) / 2 : publishedStop.lon;
	const stop = { ...publishedStop, lat, lon };
	return {
		stop,
		address: {
			lat,
			lon,
			label: 'Fixture address',
			source: 'geo_ca',
			precision: 'address',
		},
		stopsIndex: { ...fixture('stops-index.json'), stops: [stop] },
		schedule: {
			date: GENERATED.slice(0, 10),
			routes: [{ id: '80', short: '80', type: 3 }],
			stops: [{ ...stop, routes: ['80'] }],
		},
	};
}

async function serveNetwork(page: Page, provider: 'stm' | 'octranspo'): Promise<void> {
	const network = networkFor(provider);
	const at = Date.parse(GENERATED);
	const snapshot = captureFixture(at, {
		city: provider,
		vehicle_positions: [
			captureVehicle(at, {
				vehicle_id: 'V1',
				latitude: network.stop.lat,
				longitude: network.stop.lon,
				route_id: '80',
				stop_id: network.stop.id,
				delay: 0,
			}),
		],
	});
	const trips = [FIRST_ETA, SECOND_ETA, THIRD_ETA, FOURTH_ETA].map((eta, i) => ({
		trip_id: `T${i + 1}`,
		route_id: '80',
		direction_id: 1,
		start_date: null,
		start_time: null,
		relationship: 0,
		delay: i === 1 ? 120 : 0,
		stops: [
			{
				stop_id: network.stop.id,
				sequence: 1,
				arrival: null,
				departure: Date.parse(eta) / 1_000,
				arrival_delay: null,
				departure_delay: i === 1 ? 120 : 0,
				relationship: 0,
			},
		],
	}));
	await page.route('**/api/geocode**', (route) =>
		route.fulfill({ json: { results: [network.address] } }),
	);
	await page.route(`**/api/stops/slim?provider=${provider}`, (route) =>
		route.fulfill({ json: network.stopsIndex }),
	);
	await page.route(`**/api/schedule-edition?city=${provider}`, (route) =>
		route.fulfill({ json: { schedule: network.schedule } }),
	);
	await page.route(captureUrl, (route) => route.fulfill({ json: snapshot }));
	await page.route('**/api/live-trips?**', (route) => {
		const { searchParams } = new URL(route.request().url());
		const stop = searchParams.get('stop');
		const trip = searchParams.get('trip');
		return route.fulfill({
			json: {
				version: 2,
				city: provider,
				feed: snapshot.feeds.trip_updates,
				trip_updates: trips.filter((update) => stop === network.stop.id || trip === update.trip_id),
			},
		});
	});
}

async function openNearMe(page: Page, name: string): Promise<void> {
	const toggle = page.getByRole('button', { name, exact: true });
	await expect(async () => {
		if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
		await expect(toggle).toHaveAttribute('aria-expanded', 'true', { timeout: 1_000 });
	}).toPass();
}

const clocks = {
	en: { first: '08:05', second: '08:10', third: '08:15' },
	fr: { first: '08:05', second: '08:10', third: '08:15' },
} as const;

const vehicleNames = {
	en: 'Vehicle V1, 08:05',
	fr: 'Véhicule V1, 08:05',
} as const;

for (const provider of ['stm', 'octranspo'] as const) {
	for (const locale of PUBLISHED_LOCALES) {
		test(`${provider} ${locale}: the reader clock shows the network time in departures and their vehicle name`, async ({
			page,
		}) => {
			await page.clock.install({ time: Date.parse(GENERATED) + 30_000 });
			await serveNetwork(page, provider);
			await page.goto(`${localizeHref(map, locale)}?provider=${provider}`);

			const network = networkFor(provider);
			const t = mapCopy[locale];
			await openMapControls(page);
			await openNearMe(page, locale === 'fr' ? 'Près d’une adresse' : 'Near an address');
			await page
				.getByRole('searchbox', { name: t.nearMeSearchPlaceholder })
				.fill(network.address.label);
			const suggestion = page
				.getByRole('group', { name: t.nearMeSuggestions })
				.getByRole('button', { name: new RegExp(literal(network.address.label)) });
			await expect(suggestion).toBeVisible();
			// Real keyboard path: submit, then the suggestion, then the stop in the near list.
			await page.keyboard.press('Tab');
			await expect(page.getByRole('button', { name: t.nearMeSearchSubmit })).toBeFocused();
			await page.keyboard.press('Tab');
			await expect(suggestion).toBeFocused();
			await page.keyboard.press('Enter');
			await page
				.getByRole('button', { name: new RegExp(`^${literal(network.stop.name)}`) })
				.click();

			const detail = page.locator('[data-slot="map-detail-overlay"][data-selection-kind="stop"]');
			await expect(detail).toBeVisible();
			await expect(
				detail.getByRole('heading', { name: new RegExp(literal(network.stop.name)) }),
			).toBeVisible();
			const clock = clocks[locale];
			await expect(detail.locator('[data-slot="map-stop-predictions"] time')).toHaveText([
				clock.first,
				clock.second,
				clock.third,
			]);
			// The vehicle link carries the same instant in its accessible name.
			await expect(
				detail.getByRole('link', { name: vehicleNames[locale], exact: true }),
			).toBeVisible();
			// The Stop page carries the remaining predictions using the selected provider and locale.
			const expectedStopHref = `${locale === 'en' ? '' : `/${locale}`}/stop/${encodeURIComponent(network.stop.id)}?provider=${provider}&frameMode=live`;
			const moreAction = detail.getByRole('link', {
				name: locale === 'fr' ? 'Arrêt en direct' : 'Stop now',
			});
			await expect(moreAction).toHaveAttribute('href', expectedStopHref);
			const expectedStopUrl = new URL(expectedStopHref, page.url()).href;
			await moreAction.focus();
			await expect(moreAction).toBeFocused();
			await page.keyboard.press('Enter');
			await expect(page).toHaveURL(expectedStopUrl);
		});
	}
}
